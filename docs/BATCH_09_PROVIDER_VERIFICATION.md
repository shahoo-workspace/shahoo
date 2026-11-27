# Batch 09 provider verification evidence

Verification date: 2026-11-19. No live provider call, production credential, real SMS, or real payment was performed.

## PayPing

The current official simple-payment guide explicitly specifies Toman for v3 `amount` and a form-encoded POST body with a JSON string in `data`. The earlier OpenAPI-only conclusion below is historical. The guide is contract evidence. Verify the deployed path with a dedicated test token. [Official simple payment guide](https://payping.ir/help/prdakht-sadh-drgah-prdakht-aintrnti/)

The authoritative sources reviewed were [PayPing API Specification](https://docs.payping.ir/), [PayPing OpenAPI](https://statics.payping.ir/openapi.json), and the [official PayPing WooCommerce integration](https://github.com/payping/plugins-woocommerce) at commit `f2f93ff3adab7d5e63d6cc25d698de00c9f1da90`.

The official WooCommerce integration states that supported store currencies are converted to Toman before sending the order amount. The SHAHOO adapter applies the equivalent strict integer boundary: internal IRR must be positive and divisible by 10, then `amountToman = amountIrr / 10` is persisted and used for creation, callback comparison, and verification. The OpenAPI documents `POST https://api.payping.ir/v3/pay` with Bearer authentication and a JSON `PaymentModel` containing integer `amount`, `returnUrl`, and `clientRefId`. It returns a `PaymentDto` containing `paymentCode`, `url`, and the requested `amount`. The customer is sent to `/v3/pay/start/{paymentCode}`. PayPing posts the return information to the merchant `returnUrl`; the documented callback includes `status`, `clientRefId`, `paymentCode`, `paymentRefId`, and `amount` in the successful data. The implementation therefore treats the callback as untrusted input and performs server-side verification.

Final verification uses `POST https://api.payping.ir/v3/pay/verify` with `amount`, `paymentCode`, and `paymentRefId`. HTTP 202 and 502 mean verification is still processing and must be retried without starting another payment. HTTP 409 is accepted as already verified only when `metaData.code` is exactly `110`; the returned amount, payment reference, payment code, and client reference are still matched against the persisted attempt.

The official OpenAPI describes the amount as an integer payment amount but does not explicitly identify Rial or Toman. Therefore the current SHAHOO internal IRR identity boundary is retained as an explicit, integer-only boundary, but the external unit is **not independently proven** by the official evidence. PayPing activation remains blocked until the merchant documentation/account contract confirms the unit.

## SMS.ir

The authoritative source reviewed was [SMS.ir REST API](https://sms.ir/rest-api/). Verify uses `POST https://api.sms.ir/v1/send/verify`, `X-API-KEY`, JSON, `mobile`, integer `templateId`, and `parameters`. The documented example uses the `Code` parameter. A successful response has `status: 1` and `data.messageId` plus cost. The documentation lists HTTP 200 success, 400 logical errors, 401 authentication failure, 429 rate limiting, and 500 unexpected errors. The current adapter preserves the existing OTP challenge, hashing, expiry, rate limits, and exact challenge-id redemption flow.

SMS.ir documents a sandbox key and the same Verify URL, but no sandbox account or key was supplied. No provider call was made. An uncertain network outcome is not automatically retried by SHAHOO; the send remains an operational unknown rather than risking a duplicate OTP.

## Unverified assumptions

Merchant-specific PayPing amount-unit configuration, merchant callback field encoding in every account mode, merchant template approval/parameter naming in SMS.ir, real provider timeout behavior, and provider sandbox behavior remain unverified. These are recorded as limitations rather than inferred from unofficial examples.
