# PayPing configuration checklist

Status: the official v3 contract is documented below. A provider Sandbox payment from SHAHOO remains to be verified.

## Merchant and API setup

- [ ] Create/confirm the PayPing merchant account and token permissions.
- [ ] Generate a dedicated API token with only the payment permissions required by `/v3/pay` and `/v3/pay/verify`.
- [ ] Inject the token as the server-only secret `PAYPING_API_KEY` for the intended environment.
- [ ] Confirm the merchant account allows the intended callback/return URL.
- [ ] Set `PAYPING_RETURN_URL` to the HTTPS application callback URL ending in `/api/payment/payping/callback`.
- [ ] Set `PAYMENT_PROVIDER=payping` and `PAYPING_LIVE=1` only during an approved controlled activation. The application also requires production mode and a valid HTTPS return URL.

## Amount and sandbox verification

- [x] PayPing documents `amount` in Toman. SHAHOO sends its stored integer IRR amount divided by 10. [Official simple payment guide](https://payping.ir/help/prdakht-sadh-drgah-prdakht-aintrnti/)
- [ ] Use a dedicated PayPing test token and a disposable order with a total divisible by 10 IRR. PayPing documents a maximum of 2,000 Toman per test payment and 50,000 Toman across all test transactions. [Official test-token guide](https://payping.ir/help/nhoh-driaft-tokn/)
- [ ] For a local Sandbox run, use the documented localhost return-URL exception with `https://localhost:<port>/api/payment/payping/callback`, because SHAHOO validates HTTPS. Set `APP_URL` to the same origin and use a disposable PostgreSQL database with synthetic data. For real payments, the return host must match the website registered in PayPing.
- [ ] Verify that PayPing accepts the outbound IP for the test token. PayPing's payment notice requires IP registration, and the test-token guide documents the localhost exception for the return URL. [IP notice](https://t.me/payping/985)
- [ ] Verify request amount, `clientRefId`, returned `paymentCode`, redirect host, callback fields, and `/v3/pay/verify` response.
- [ ] Complete verification within 10 minutes of payment. The v3 callback is a form-encoded POST with `status`, `errorCode`, and a JSON string in `data`. Verify against the original `amount`; `gatewayAmount` can include payer fees. [Official simple payment guide](https://payping.ir/help/prdakht-sadh-drgah-prdakht-aintrnti/)
- [ ] Test provider rejection, timeout/unknown creation outcome, duplicate callback, and documented HTTP 409 `metaData.code=110` behavior.
- [ ] Verify the dashboard can identify an unknown creation outcome by order/client reference. If it cannot, keep the attempt in manual review and do not create a replacement payment.

## Live activation gate

- [ ] Sandbox evidence reviewed by the owner.
- [ ] Real callback URL reachable over trusted HTTPS from PayPing.
- [ ] Sandbox evidence confirms the order amount matches the PayPing amount after IRR-to-Toman conversion.
- [ ] PostgreSQL migration `0013`–`0015` applied through the guarded migration procedure.
- [ ] Rollback/recovery contact and dashboard procedure documented.
- [ ] Enable live configuration only after all above checks; no code change should be needed to add the token.
