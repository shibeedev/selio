import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier, dynamicCredentialLookup } from "./requireDynamicUser.js";

const ENVIRONMENT_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "9327aba8-7f91-4bb8-afc8-5449d3e3b671";
const WALLET = "0x6112aBcDeF0123456789aBcDeF0123456789A694";
const WALLET_CREDENTIAL = { address: WALLET, chain: "eip155", format: "blockchain", walletName: "dynamicwaas" };

let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
});

function token(claims: Record<string, unknown>) {
  return new SignJWT({ environment_id: ENVIRONMENT_ID, scope: "user:basic", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`app.dynamicauth.com/${ENVIRONMENT_ID}`)
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);
}

describe("createTokenVerifier with a credential lookup", () => {
  it("reads the wallets from the lookup when the token is minified (no verified_credentials)", async () => {
    const asked: string[] = [];
    const verify = createTokenVerifier(ENVIRONMENT_ID, keys, async (userId) => {
      asked.push(userId);
      return [{ format: "email", email: "user@example.com" }, WALLET_CREDENTIAL];
    });
    const user = await verify(await token({ verifiedCredentialsHashes: { blockchain: "h", email: "h" } }));
    expect(asked).toEqual([USER_ID]);
    expect(user).toEqual({ userId: USER_ID, addresses: [WALLET.toLowerCase()] });
  });

  it("keeps using the token's verified_credentials when present, without a lookup call", async () => {
    let calls = 0;
    const verify = createTokenVerifier(ENVIRONMENT_ID, keys, async () => {
      calls += 1;
      return [];
    });
    const user = await verify(await token({ verified_credentials: [WALLET_CREDENTIAL] }));
    expect(calls).toBe(0);
    expect(user.addresses).toEqual([WALLET.toLowerCase()]);
  });

  it("fails verification when the lookup fails", async () => {
    const verify = createTokenVerifier(ENVIRONMENT_ID, keys, async () => {
      throw new Error("Dynamic user lookup answered 401");
    });
    await expect(verify(await token({}))).rejects.toThrow("401");
  });
});

describe("dynamicCredentialLookup", () => {
  it("calls the admin users endpoint with the API token and returns the user's verified credentials", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ user: { id: USER_ID, verifiedCredentials: [WALLET_CREDENTIAL] } }), { status: 200 });
    }) as typeof fetch;
    const credentials = await dynamicCredentialLookup(ENVIRONMENT_ID, "dyn_token", fetchImpl)(USER_ID);
    expect(seen).toEqual([
      { url: `https://app.dynamic.xyz/api/v0/environments/${ENVIRONMENT_ID}/users/${USER_ID}`, auth: "Bearer dyn_token" },
    ]);
    expect(credentials).toEqual([WALLET_CREDENTIAL]);
  });

  it("throws on a non-2xx answer", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await expect(dynamicCredentialLookup(ENVIRONMENT_ID, "dyn_token", fetchImpl)(USER_ID)).rejects.toThrow("403");
  });
});
