# launchd fleet snapshot: 2026-07-29 (pre-migration, MacBook Air M2)

Captured for the Air→MBP M5 migration. Source of truth was `~/Library/LaunchAgents/`
(78 active plists; the 48 stale `.bak*` files were deliberately NOT copied) plus the
five wrapper-script locations that live OUTSIDE any repo.

## Contents

- `plists/`: all 78 active plists. Only 3 of these were symlinks back into
  `~/Documents/career-ops/scripts/launchd/` (career-library, career-ops-health,
  overpay-signals); the other 75 existed ONLY in ~/Library/LaunchAgents before
  this snapshot.
- `wrappers/career-ops-wrappers/`: from `~/.local/career-ops-wrappers/`
  (cloudflared-nohup.sh, cloudflared-staging-nohup.sh, cron-run.sh,
  dashboard-server-nohup.sh)
- `wrappers/llm-memory-wrappers/`: from `~/.local/llm-memory-wrappers/`
- `wrappers/secrets-launchd-setenv.sh`: from `~/.local/bin/` (the secrets-env
  loader that populates launchctl env from ~/.secrets)
- `wrappers/staging-tunnel-watchdog.sh`: from `~/.cloudflared/`
- `wrappers/mesa-sort.sh`: from `~/mesa-vault/.mesa/scripts/sort.sh`

## Known fragilities (verify on the new machine)

1. **Hardcoded node path** `~/.nvm/versions/node/v24.14.0/bin/node` in
   mission-control, alignment-watcher, chrome-debugging, network-database-build,
   network-enrich-batch, and in the EnvironmentVariables PATH of most career-ops
   plists. New machine needs `nvm install 24.14.0` BEFORE the fleet loads.
   (Interactive shell uses brew node v26.5.0, the fleet and shell disagree.)
2. **Hardcoded /Users/mitchellwilliams paths everywhere.** New Mac MUST use the
   same short username.
3. **Tahoe launchd pattern (bug-class-catalog Pattern F):** persistent daemons
   are supervised via nohup-wrapper plists, NOT KeepAlive. Three load-bearing
   details: `AbandonProcessGroup=true`, `</dev/null` on the nohup line, and
   wrapper scripts + plist log paths must live OUTSIDE ~/Documents (TCC blocks
   launchd exec of scripts under Documents on Tahoe). Do not "simplify" these.
4. After migration, TCC grants reset, re-grant Full Disk Access etc. and smoke
   test: `launchctl list | grep -v com.apple` should show status 0 across the fleet.
5. Known-broken before migration (do not carry): Adobe ARMDCHelper (status 111),
   Google Keystone stubs (empty ProgramArguments, Dec 2023),
   contact-enrichment-audit (one-shot dated 2026-06-18, already past).
