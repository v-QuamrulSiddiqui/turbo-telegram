// GitHub Copilot authentication via OAuth device flow.
//
// This lets the extension use GitHub Copilot without the user managing an API key:
// the user signs in with their GitHub account (which must have a Copilot subscription)
// once, and the extension exchanges the resulting OAuth token for a short-lived Copilot
// token on demand. This is the same device-flow + token-exchange approach used by editor
// integrations such as copilot.vim.
//
// Note: the Copilot token-exchange and chat endpoints used here are GitHub's internal
// editor APIs, not officially documented public APIs.

// Public client id used by GitHub's first-party Copilot editor plugins for device flow.
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_CHAT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";

const OAUTH_KEY = "wcagReviewerCopilotOAuth";
const COPILOT_TOKEN_KEY = "wcagReviewerCopilotToken";

// Editor identification headers required by the Copilot chat endpoint.
export function copilotHeaders() {
  return {
    "Editor-Version": "GitHubBugReviewer/1.4.1",
    "Editor-Plugin-Version": "wcag-bug-reviewer/1.4.1",
    "Copilot-Integration-Id": "vscode-chat"
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function storageGet(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key];
}

export async function isSignedIn() {
  const oauth = await storageGet(OAUTH_KEY);
  return Boolean(oauth?.access_token);
}

export async function signOut() {
  await chrome.storage.local.remove([OAUTH_KEY, COPILOT_TOKEN_KEY]);
}

// Step 1: request a device + user code. The caller shows user_code and verification_uri
// to the user and then calls pollForAccessToken.
export async function startDeviceFlow(scope = "read:user") {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope })
  });
  if (!response.ok) {
    throw new Error(`Could not start GitHub sign-in (${response.status}).`);
  }
  const data = await response.json();
  if (!data.device_code) {
    throw new Error(data.error_description || "GitHub did not return a device code.");
  }
  return data;
}

// Step 2: poll until the user authorizes the device (or the code expires). Stores the
// resulting OAuth token and returns it.
export async function pollForAccessToken(deviceCode, intervalSeconds = 5, expiresInSeconds = 900) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(intervalSeconds, 1) * 1000;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });
    const data = await response.json().catch(() => ({}));
    if (data.access_token) {
      const record = {
        access_token: data.access_token,
        token_type: data.token_type || "bearer",
        scope: data.scope || "",
        obtained_at: Date.now()
      };
      await chrome.storage.local.set({ [OAUTH_KEY]: record });
      return record;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(data.error_description || data.error || "GitHub sign-in failed.");
  }
  throw new Error("GitHub sign-in timed out before it was approved.");
}

// Exchanges the stored OAuth token for a short-lived Copilot token, caching it until it
// nears expiry. Returns a bearer token string usable against the Copilot chat endpoint.
export async function getCopilotToken() {
  const cached = await storageGet(COPILOT_TOKEN_KEY);
  if (cached?.token && cached.expires_at && cached.expires_at - 60 > Math.floor(Date.now() / 1000)) {
    return cached.token;
  }
  const oauth = await storageGet(OAUTH_KEY);
  if (!oauth?.access_token) {
    throw new Error("Sign in with GitHub Copilot in Settings first.");
  }
  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${oauth.access_token}`,
      Accept: "application/json"
    }
  });
  if (response.status === 401 || response.status === 403) {
    await signOut();
    throw new Error("GitHub Copilot access was rejected. Confirm your account has Copilot, then sign in again.");
  }
  if (!response.ok) {
    throw new Error(`Could not obtain a Copilot token (${response.status}).`);
  }
  const data = await response.json();
  if (!data.token) {
    throw new Error("GitHub did not return a Copilot token; a Copilot subscription may be required.");
  }
  const record = {
    token: data.token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + 300
  };
  await chrome.storage.local.set({ [COPILOT_TOKEN_KEY]: record });
  return record.token;
}
