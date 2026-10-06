import type { KeyObject } from "node:crypto";
import { signReviewResponse, verifyReviewSignature } from "../../shared/crypto/signatures.js";
import type { Transactional } from "../../shared/db/database.js";
import { AGENT_CHAIN_ID, type ChainPort } from "../../shared/integrations/chain/chain.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { DelegationPort } from "../delegations/index.js";
import type { IntentRepository } from "../executor/intents.repository.js";
import { checkReviewRequest, DENY, type ReviewRequest } from "../policy/policy.js";

export interface ReviewServiceOptions {
  /** Webhook secret of Transaction Review; unset: every request fails verification. */
  secret?: string;
  /** Ed25519 key that signs the answers (x-dynamic-response-signature). */
  signingKey?: KeyObject;
}

export interface ReviewAnswer {
  status: 200 | 401;
  /** The exact response bytes; the signature covers them. */
  body: string;
  signature?: string;
}

export class ReviewService {
  constructor(
    private readonly intents: IntentRepository,
    private readonly delegations: Pick<DelegationPort, "findByWalletId">,
    private readonly chain: Pick<ChainPort, "deployment">,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly options: ReviewServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** F.7: verify, check statically (no chain read, well within Dynamic's 5-second limit), answer. */
  review(body: Buffer, signature: string | undefined): ReviewAnswer {
    if (!this.options.secret || !verifyReviewSignature(this.options.secret, body, signature)) {
      return this.answer(401, { proceed: false, reason: "Invalid signature" });
    }
    let request: ReviewRequest;
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      request = parsed !== null && typeof parsed === "object" ? (parsed as ReviewRequest) : {};
    } catch {
      request = {};
    }
    let deployment: ReturnType<ChainPort["deployment"]> | null;
    try {
      deployment = this.chain.deployment();
    } catch {
      deployment = null;
    }
    const check = checkReviewRequest(request, deployment);
    if (check.verdict === "proceed") return this.answer(200, { proceed: true });
    if (check.verdict === "deny") return this.deny(request, check.reason);
    const now = this.now();
    const approved = this.inTransaction((tx) => {
      const delegation = this.delegations.findByWalletId(check.walletId);
      if (!delegation || delegation.status !== "active") return false;
      const intent = this.intents.findMatch(
        { walletId: check.walletId, chainId: AGENT_CHAIN_ID, to: check.to, nonce: check.nonce, dataHash: check.dataHash, now },
        tx,
      );
      return intent !== null && this.intents.markUsed(intent, tx);
    });
    return approved ? this.answer(200, { proceed: true }) : this.deny(request, DENY.intent);
  }

  private deny(request: ReviewRequest, reason: string): ReviewAnswer {
    this.logger.info({ shareSetType: typeof request.shareSetType === "string" ? request.shareSetType : null, reason }, "review denied");
    return this.answer(200, { proceed: false, reason });
  }

  private answer(status: 200 | 401, value: { proceed: true } | { proceed: false; reason: string }): ReviewAnswer {
    const body = JSON.stringify(value);
    return {
      status,
      body,
      ...(this.options.signingKey ? { signature: signReviewResponse(this.options.signingKey, Buffer.from(body)) } : {}),
    };
  }
}
