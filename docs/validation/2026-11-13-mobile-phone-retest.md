# Mobile phone retest: off-network access

**Plan:** [Reliable mobile access](../plans/2026-11-13-mobile-remote-access-plan.md), phase 1 exit (and the phone part of phase 4).
**Status:** Ready to run. Not yet run; nothing has been deployed.

This checks the user's original report: mobile works on the same Wi-Fi but fails elsewhere, even with Tailscale. Results from a real phone are the only evidence that closes phase 1.

## Build state required

The hosted site (`mobile.bigbud.app`) does not have the new diagnostics. Use the desktop's own `/mobile` build over the tailnet:

1. From the repository root, run `bun run build:mobile-web:desktop`. This builds with `/mobile/` asset URLs and copies the result from `apps/mobile-web/dist` into `apps/server/dist/mobile-web`, where the bundled desktop backend resolves it. The workspace-only mobile build does not perform that copy.
2. Run the desktop app from this checkout: `bun run dev:desktop`.
3. In the desktop app, open **Settings → Mobile remote control**:
   - Turn **Mobile remote control** on.
   - Enable **Tailscale Serve**. The remote access checklist should show every computer step passing.
   - Under **Mobile app URL**, choose **Custom** and enter `https://<this-computer>.<tailnet>.ts.net/mobile`.
   - The backend URL should be the same `https://…ts.net` origin. Its note should read "Designed for use from other networks".
4. On the phone: install Tailscale, sign in to the same tailnet, and turn it on. Note the phone model, OS version, browser and its version, and the Tailscale version.

Never copy session tokens, pairing secrets or the full pairing link into notes or screenshots. The **Connection details** panel shows addresses only and is safe to capture.

## Steps and expected results

| #   | Action                                                                                  | Expected                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | On the same Wi-Fi as the desktop, create a pairing link, open it on the phone, and pair | The pairing screen shows the `ts.net` backend; pairing succeeds; chats load                                                                                                                       |
| 2   | Send a short message in an existing chat                                                | It is delivered and the reply streams                                                                                                                                                             |
| 3   | Turn the phone's Wi-Fi **off** (cellular only, Tailscale still on) and reload the app   | It reconnects; chats load; sending works                                                                                                                                                          |
| 4   | Still on cellular, switch Tailscale **off** on the phone                                | Within about 10 s: "Still trying to reach the desktop". **Connection details** lists the `ts.net` origin as a tailnet address and the failing stage. It does not ask you to pair again            |
| 5   | Switch Tailscale back **on**, then tap Retry                                            | It reconnects, with no duplicate messages                                                                                                                                                         |
| 6   | Put the desktop to sleep, wait 1 minute, then reload the phone                          | It keeps retrying, and the details show the host can't be reached. After the desktop wakes, Retry reconnects                                                                                      |
| 7   | On the desktop, turn Mobile remote control **off**                                      | The phone shows "Mobile access is off on the desktop" and stays paired. Turning it back on and tapping Retry reconnects                                                                           |
| 8   | Type a message, switch Wi-Fi↔cellular, and send during the switch                       | Either it is delivered once, or it shows "Delivery is uncertain" and resolves by itself after reconnecting. If the desktop has no record, **Send again** appears. The message never appears twice |
| 9   | Lock the phone for 30 minutes with an unsent draft, then unlock                         | It catches up with new messages and the draft is still there                                                                                                                                      |
| 10  | On the desktop, revoke this phone's session                                             | The phone shows "Pairing required" right away and does not keep retrying                                                                                                                          |

## If step 3 fails

Do not change anything yet. Open **Connection details** on the phone and record, without tokens:

- the origin shown and how it is classified (tailnet, same network or other)
- which stage failed (page load, pairing request, live connection)
- the message shown

Then record the desktop checklist state and the output of `tailscale serve status` on the desktop. This separates the candidate causes:

- an old saved LAN address
- the phone not connected to Tailscale
- tailnet access rules
- a Serve mapping that is stale or belongs to another service
- TLS or DNS on the phone
- browser private-network restrictions

## Record

For each step, record: pass or fail, the time to reconnect where relevant, and the text of any notice. Add the device, OS, browser and Tailscale versions, and whether the phone was on Wi-Fi or cellular.

## Remaining qualification worksheet

This worksheet prepares the remaining phase gates; it does not authorize access, deployment or claim execution. Record build/revision, OS/architecture, browser, start/end time, result and redacted evidence for each case. Use disposable test conversations; never capture pairing fragments or credentials.

| Gate                     | Required setup                                                                              | Procedure and pass evidence                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 native execution      | Authorized Windows and native x86_64 test hosts with the pinned toolchain                   | Run the gateway crate's scoped formatting, Clippy and tests using the repository command reference. Record actual native architecture and toolchain. Cross-compilation and emulation do not satisfy execution.                                                                                                                              |
| P2 Serve and lifecycle   | Approved test host configuration, gateway launcher integration and remote lifecycle handoff | Record existing Serve ownership before changes. Confirm private HTTPS reaches the narrow gateway, broad RPC stays unavailable, backend restart preserves the public endpoint, and gateway restart does not restart backend/provider work. Restore only configuration owned by this test. No Serve mutation is authorized by this worksheet. |
| P3 direct authority      | Remote P7 runtime handoff, two separately paired authorities and explicit mobile consent    | Confirm persistent authority identity across restart; pair through the authenticated backend owner interface, never the installation-control socket. Shut down the laptop, complete a VPS-owned turn/approval and observe canonical state from a second client. Reject incompatible writes.                                                 |
| P3/P4 host isolation     | P3 host-session implementation ready                                                        | Give each authority distinct disposable drafts and pending decisions. Switch during a held response; verify late frames cannot update the other host, credentials never cross origins, and receipts are queried only under their original authority. Changing a display name or backend version must not merge hosts.                       |
| P5 desktop comparison    | Explicit permission for a designated non-sensitive desktop test session                     | Compare desktop and fixture mobile navigation, title, transcript, work log, approval, question, composer, model picker, loading/empty/error states in both themes. Record each difference and intended responsive behavior. Existing mobile captures alone do not establish desktop parity.                                                 |
| P5 actual keyboard       | Authorized physical phone/browser, on-screen and external keyboard                          | At each supported narrow width, focus the composer, open/close the keyboard, rotate and check safe areas, Send/Approve reachability, retained draft and reader position. Tab through controls; test Enter/Space, Escape and focus restoration without traps. Reduced viewport simulation is insufficient.                                   |
| P5 assistive technology  | Physical phone with VoiceOver or TalkBack enabled                                           | Verify composer Message/Your answer names, work-log expanded/collapsed announcement and controlled content, question choices, approval actions, connection/delivery notices and sensible focus order. Record device and assistive-technology versions.                                                                                      |
| P4 live-size measurement | Separate permission naming the live database and permitted read-only queries                | Record only size/count/timing aggregates and the selected query scope. Do not dump prompt bodies or credentials, copy the whole database or run broad scans without approval. Synthetic envelope bounds remain separate evidence.                                                                                                           |
| P6 release/rollback      | Prior gates met, signed optional artifacts and explicit release authorization               | Confirm mobile-disabled installations do not fetch/start optional assets; verify artifact compatibility, staged update and rollback without database rollback. Confirm reconnect cannot replay accepted commands. Record platform-specific lifecycle results before publishing setup claims.                                                |

Safe preparation already available: temporary-state gateway/restart and mobile delivery/recovery tests, the 180-case fixture matrix, reader geometry and drawer lifecycle harnesses. Use the [browser validation guide](../../apps/mobile-web/tests/browser/README.md) and [command reference](../COMMANDS.md); rerun only affected scopes when code or evidence gaps justify it. Geometry and rejection-resume share port 15748; drawer and isolation share port 15747, so those pairs must run sequentially.

## Minimum user-run acceptance handoff

From `/Users/youpele/DevWorld/bigbud`, run these existing commands in order (they are setup/build commands, not permission for broad validation):

```sh
bun run build:mobile-web:desktop
bun run dev:desktop
```

Keep the desktop running and use a disposable test chat. In Settings → Mobile remote control, enable access and Tailscale Serve, then set the custom mobile URL to `https://<actual-host>.<actual-tailnet>.ts.net/mobile`. Copy the actual hostname from the desktop checklist; the placeholders are not a ready endpoint. Set the backend to the same HTTPS origin without `/mobile`. Confirm the URL loads the app before pairing. If it returns “Mobile companion is not available,” verify the copied assets and restart the test desktop backend. This procedure targets the existing desktop path; it does not certify gateway supervisor integration or VPS readiness.

With phone Tailscale connected and authorized, the minimum sequence is: pair/send on Wi-Fi → disable Wi-Fi and send on cellular → send during Wi-Fi/cellular switching and confirm one delivery → retain a draft across 30-minute phone lock → sleep/wake the desktop and confirm honest unreachability/recovery → revoke the phone and confirm pairing is required without continued retries. Record failures through Connection details and the step number; never share pairing links or tokens. The full table above includes access-off and Tailscale-off diagnostics when needed.

Separate actions still required: designate/approve desktop test captures and read-only live-size measurement; provide Windows/native x86_64 hosts; perform physical keyboard and screen-reader cases. Remote P7 production authority readiness remains an engineering prerequisite owned by the remote worker, not a phone test for the user to improvise.
