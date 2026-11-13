# Hermes test (S0): record

**Date:** 2026-11-12
**Hermes:** Hermes Agent 0.23.1 (`GET /health` reports `{"status": "ok", "platform": "hermes-agent", "version": "0.23.1"}`), deployed in namespace `hermes-agent` by the Helm chart in the `home_lab` repo (Argo CD app, image tag from that chart). The model provider is a Claude subscription through the `claude-subscription-directsdk` plugin, default model `sonnet`.
**How it was run:** `kubectl port-forward svc/hermes-agent 18642:8642` from the author's machine, then `curl` with `Authorization: Bearer <API_SERVER_KEY>` (the key was read from the cluster Secret into a private header file that was deleted afterwards). Requests used `stream: false` and `model: "hermes-agent"` (the only id `GET /v1/models` lists).

## Results

| Question | Result | Evidence |
| --- | --- | --- |
| Does `/health` work without a key? | Yes, HTTP 200 | `GET /health` |
| Does `/v1/models` need the key? | Yes. 401 without it, 200 with it (reported by the deployment session; not repeated here) | deployment session |
| Is the system message honoured? | Yes. With "answer in Spanish, one short sentence, no markdown" the reply was one Spanish sentence | test A |
| Does `X-Hermes-Session-Id` keep a session? | Yes. A second request with the same ID and only the new message ("what is my name and favourite colour?") answered correctly | test B |
| Does the reply echo the header? | Yes, `X-Hermes-Session-Id` comes back in the response headers | tests A to C |
| Is a different session isolated? | **No.** A new session ID asked the same question and also answered correctly ("from an earlier conversation"). Hermes searched its own memory or past sessions, so memory is shared across sessions | test C |
| Latency, non-streaming, no tools | 2.5 s to 4.2 s per turn | tests A and B |
| Latency with Hermes memory lookup | 8.6 s | test C |
| Tokens per turn | About 17,200 prompt tokens for a one-line question (Hermes system prompt and tools); 55,550 when it searched memory | `usage` field |
| Can Hermes call Blob's `/alerts` with a bearer token and report the result? | **Yes** (tested 2026-11-13 against the deployed Blob). Asked through the chat API to run `curl -X POST http://blob.blob-test.svc.cluster.local/alerts` with the alert token in the prompt, Hermes ran it from its terminal and answered `HTTP 201` with the created alert (`state: pending`, `fire_at` 90 s ahead); `GET /alerts` showed it. The token passed through Hermes's context, so it may sit in Hermes's memory; the one used was a test token in a namespace that was deleted afterwards. The timer rule in Blob stays on as a fallback (`TIMER_RULE`) | 2026-11-13 test |
| Does a client disconnect stop a Hermes run? | **Not tested** | pending |
| Is there a separate profile or toolset for Blob? | **Not tested** | pending |

## What this changes in the design

*   **History:** the `session` mode (send `X-Hermes-Session-Id` and only the new message) works. Set `HERMES_HISTORY_MODE=session`. The `replay` mode is not needed for now.
*   **Reply timing:** a plain turn takes about 3 s of Hermes time, which fits the loose 6 s target for SC1 once speech-to-text (about 1 s, unmeasured) and synthesis are added. A turn where Hermes searches memory or uses tools takes 8 s or more and will miss it. The filler phrase (deferred) becomes more useful than assumed.
*   **Cost:** every turn spends about 17,000 input tokens of the subscription quota (prompt caching lowers repeat cost; unverified). A reduced Hermes profile or toolset for Blob is worth testing before daily use.
*   **Memory is shared:** anything said to Blob can be remembered by Hermes and shown in other sessions. This matches the "memory is per profile, not per speaker" caveat. Test A put "my name is Arnau, favourite colour green" into Hermes's memory; that is harmless but it is now there.
*   **Security:** the deployment session reported that the API listens on all interfaces and that whoever holds `API_SERVER_KEY` can run commands in the pod (the terminal is not isolated) and read the Claude token. A NetworkPolicy that only lets Blob's pod reach port 8642 is recommended and not yet applied.

## Still to do in this spike

1.  Stub `POST /alerts` on a machine reachable from the Hermes pod, and test whether Hermes can call it with a bearer token and report a failure (this decides whether `timer_rule.py` is built).
2.  Test a client disconnect during a long run (does the run stop?).
3.  Check whether a Hermes profile with fewer tools lowers the 17,000-token prompt.
