/**
 * StratoForce AI — OAuth 2.1 Authorization Server for MCP
 * 
 * Implements RFC 9728 (OAuth 2.1 for MCP) with PKCE (S256).
 * Allows customer orgs to connect their Salesforce instance to the MCP server
 * without sharing credentials — they authorize via Salesforce OAuth, we exchange
 * for an access token scoped to their org.
 * 
 * Flow:
 *   1. Client → GET /oauth/authorize (with PKCE challenge)
 *   2. Redirect → Salesforce OAuth consent screen
 *   3. Salesforce → callback with auth code
 *   4. Client → POST /oauth/token (with PKCE verifier)
 *   5. We exchange SF auth code → SF access token
 *   6. Return our own JWT wrapping the SF session
 * 
 * @version 1.0.0
 * @since MCP v2.1
 */

import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

// ── Config ──

const OAUTH_CONFIG = {
  // Salesforce Connected App (StratoForce MCP)
  clientId: process.env.SF_OAUTH_CLIENT_ID || '',
  clientSecret: process.env.SF_OAUTH_CLIENT_SECRET || '',
  
  // Our server
  issuer: process.env.OAUTH_ISSUER || 'https://mcp.stratoforce.ai',
  jwtSecret: process.env.OAUTH_JWT_SECRET || randomBytes(32).toString('hex'),
  tokenExpirySeconds: 3600, // 1 hour
  refreshExpirySeconds: 86400 * 30, // 30 days
  
  // Salesforce OAuth endpoints
  sfAuthorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
  sfTokenUrl: 'https://login.salesforce.com/services/oauth2/token',
  
  // Callback
  callbackPath: '/oauth/callback',
};

// ── In-memory stores (replace with Redis/DB in production) ──

const authRequests = new Map();  // code_challenge → { state, redirectUri, createdAt }
const authCodes = new Map();     // code → { sfAccessToken, sfInstanceUrl, orgId, codeChallenge, createdAt }
const refreshTokens = new Map(); // refreshToken → { sfRefreshToken, sfInstanceUrl, orgId, createdAt }

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authRequests) if (now - v.createdAt > 600000) authRequests.delete(k);
  for (const [k, v] of authCodes) if (now - v.createdAt > 600000) authCodes.delete(k);
  for (const [k, v] of refreshTokens) if (now - v.createdAt > OAUTH_CONFIG.refreshExpirySeconds * 1000) refreshTokens.delete(k);
}, 600000);

// ── Helpers ──

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateCode() {
  return base64url(randomBytes(32));
}

function verifyCodeChallenge(verifier, challenge) {
  const computed = base64url(createHash('sha256').update(verifier).digest());
  return computed === challenge;
}

async function createJWT(payload) {
  const secret = new TextEncoder().encode(OAUTH_CONFIG.jwtSecret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(OAUTH_CONFIG.issuer)
    .setExpirationTime(`${OAUTH_CONFIG.tokenExpirySeconds}s`)
    .sign(secret);
}

async function verifyJWT(token) {
  const secret = new TextEncoder().encode(OAUTH_CONFIG.jwtSecret);
  const { payload } = await jwtVerify(token, secret, { issuer: OAUTH_CONFIG.issuer });
  return payload;
}

// ── Route Handlers ──

/**
 * GET /oauth/authorize
 * 
 * Starts the OAuth flow. Client sends PKCE challenge.
 * We redirect to Salesforce login.
 * 
 * Query params:
 *   response_type=code
 *   client_id=stratoforce-mcp
 *   redirect_uri=<client callback>
 *   code_challenge=<S256 hash>
 *   code_challenge_method=S256
 *   state=<opaque>
 *   login_url=<optional SF login URL for sandbox/custom domain>
 */
function handleAuthorize(req, res) {
  const {
    response_type,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    login_url,
  } = req.query;

  // Validate
  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    return res.status(400).json({ error: 'invalid_request', description: 'PKCE S256 required' });
  }
  if (!redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', description: 'redirect_uri required' });
  }

  // Store the auth request
  const internalState = base64url(randomBytes(16));
  authRequests.set(internalState, {
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
    clientState: state,
    createdAt: Date.now(),
  });

  // Build Salesforce authorize URL
  const sfLoginUrl = login_url || OAUTH_CONFIG.sfAuthorizeUrl;
  const sfAuthorize = new URL(sfLoginUrl);
  sfAuthorize.searchParams.set('response_type', 'code');
  sfAuthorize.searchParams.set('client_id', OAUTH_CONFIG.clientId);
  sfAuthorize.searchParams.set('redirect_uri', `${OAUTH_CONFIG.issuer}${OAUTH_CONFIG.callbackPath}`);
  sfAuthorize.searchParams.set('state', internalState);
  sfAuthorize.searchParams.set('scope', 'api refresh_token');
  sfAuthorize.searchParams.set('prompt', 'login consent');

  res.redirect(302, sfAuthorize.toString());
}

/**
 * GET /oauth/callback
 * 
 * Salesforce redirects here after user authorizes.
 * We exchange the SF code for tokens, then redirect the client with our code.
 */
async function handleCallback(req, res) {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({ error, description: error_description });
  }

  const authReq = authRequests.get(state);
  if (!authReq) {
    return res.status(400).json({ error: 'invalid_state' });
  }
  authRequests.delete(state);

  try {
    // Exchange SF auth code for SF tokens
    const tokenRes = await fetch(OAUTH_CONFIG.sfTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: `${OAUTH_CONFIG.issuer}${OAUTH_CONFIG.callbackPath}`,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Salesforce token exchange failed: ${err}`);
    }

    const sfTokens = await tokenRes.json();

    // Generate our authorization code
    const ourCode = generateCode();
    authCodes.set(ourCode, {
      sfAccessToken: sfTokens.access_token,
      sfRefreshToken: sfTokens.refresh_token,
      sfInstanceUrl: sfTokens.instance_url,
      orgId: sfTokens.id?.split('/')[4] || 'unknown',
      codeChallenge: authReq.codeChallenge,
      createdAt: Date.now(),
    });

    // Redirect client with our code
    const clientRedirect = new URL(authReq.redirectUri);
    clientRedirect.searchParams.set('code', ourCode);
    if (authReq.clientState) clientRedirect.searchParams.set('state', authReq.clientState);

    res.redirect(302, clientRedirect.toString());
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).json({ error: 'server_error', description: err.message });
  }
}

/**
 * POST /oauth/token
 * 
 * Token exchange — client sends our code + PKCE verifier.
 * We verify PKCE, return JWT access token + refresh token.
 * 
 * Also handles refresh_token grant.
 */
async function handleToken(req, res) {
  const { grant_type, code, code_verifier, refresh_token } = req.body;

  if (grant_type === 'authorization_code') {
    if (!code || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const authCode = authCodes.get(code);
    if (!authCode) {
      return res.status(400).json({ error: 'invalid_grant', description: 'Code expired or invalid' });
    }
    authCodes.delete(code);

    // Verify PKCE
    if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge)) {
      return res.status(400).json({ error: 'invalid_grant', description: 'PKCE verification failed' });
    }

    // Issue our JWT
    const accessToken = await createJWT({
      sub: authCode.orgId,
      instance_url: authCode.sfInstanceUrl,
      sf_token: authCode.sfAccessToken,
      scope: 'mcp:read mcp:write',
    });

    // Issue refresh token
    const newRefreshToken = generateCode();
    refreshTokens.set(newRefreshToken, {
      sfRefreshToken: authCode.sfRefreshToken,
      sfInstanceUrl: authCode.sfInstanceUrl,
      orgId: authCode.orgId,
      createdAt: Date.now(),
    });

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_CONFIG.tokenExpirySeconds,
      refresh_token: newRefreshToken,
      scope: 'mcp:read mcp:write',
    });
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const stored = refreshTokens.get(refresh_token);
    if (!stored) {
      return res.status(400).json({ error: 'invalid_grant', description: 'Refresh token expired or invalid' });
    }

    // Refresh SF token
    try {
      const sfRes = await fetch(OAUTH_CONFIG.sfTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: stored.sfRefreshToken,
          client_id: OAUTH_CONFIG.clientId,
          client_secret: OAUTH_CONFIG.clientSecret,
        }),
      });

      if (!sfRes.ok) throw new Error('SF refresh failed');
      const sfTokens = await sfRes.json();

      const accessToken = await createJWT({
        sub: stored.orgId,
        instance_url: sfTokens.instance_url || stored.sfInstanceUrl,
        sf_token: sfTokens.access_token,
        scope: 'mcp:read mcp:write',
      });

      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: OAUTH_CONFIG.tokenExpirySeconds,
        scope: 'mcp:read mcp:write',
      });
    } catch (err) {
      refreshTokens.delete(refresh_token);
      return res.status(400).json({ error: 'invalid_grant', description: 'SF refresh failed' });
    }
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
}

/**
 * OAuth middleware for MCP routes.
 * Validates JWT Bearer token from Authorization header.
 * Attaches { orgId, instanceUrl, sfToken } to req.sfAuth.
 */
async function oauthMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', description: 'Bearer token required' });
  }

  try {
    const payload = await verifyJWT(auth.slice(7));
    req.sfAuth = {
      orgId: payload.sub,
      instanceUrl: payload.instance_url,
      sfToken: payload.sf_token,
      scope: payload.scope,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token', description: 'Token expired or invalid' });
  }
}

/**
 * RFC 9728 — OAuth Protected Resource Metadata
 * GET /.well-known/oauth-protected-resource
 */
function handleResourceMetadata(req, res) {
  res.json({
    resource: OAUTH_CONFIG.issuer,
    authorization_servers: [OAUTH_CONFIG.issuer],
    scopes_supported: ['mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header'],
  });
}

/**
 * RFC 8414 — OAuth Authorization Server Metadata
 * GET /.well-known/oauth-authorization-server
 */
function handleServerMetadata(req, res) {
  res.json({
    issuer: OAUTH_CONFIG.issuer,
    authorization_endpoint: `${OAUTH_CONFIG.issuer}/oauth/authorize`,
    token_endpoint: `${OAUTH_CONFIG.issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:read', 'mcp:write'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

// ── Exports ──

export {
  OAUTH_CONFIG,
  handleAuthorize,
  handleCallback,
  handleToken,
  handleResourceMetadata,
  handleServerMetadata,
  oauthMiddleware,
  verifyJWT,
};
