# Deployment: prepared, not done

AnyTune isn't deployed. Its source is public at **github.com/obinexus/anytune** (since 2026-09-30). This document prepares the deployment for the owner's separate authorisation. **None of the hosting, DNS or header steps below has been taken.**

## What would be deployed

`npm run build` writes a static site to `dist/app`:

- `index.html`
- `assets/index-<hash>.js`: the application and Vue's runtime, about 89 kB, 33 kB gzipped
- `assets/index-<hash>.css`
- `obix-runtime-manifest.json`

It needs no server code, no Obicall and no database. Any static host serves it.

## anytune.obinexus.org (proposed)

1. **Hosting.** A static host serving `dist/app` from the repository's default branch, built with Node ≥ 26 and `npm ci && npm run build`. Examples: GitHub Pages with an Actions workflow, Cloudflare Pages, or Netlify. The OBIX packages come from npm (see *The OBIX packages* below).
2. **DNS.** A `CNAME` record `anytune.obinexus.org` → the host's target, added by whoever administers `obinexus.org`.
3. **HTTPS.** Required: the future microphone input needs a secure context (`getUserMedia`). All the hosts above issue certificates.
4. **Headers** (suggested):
   - `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
   - `Permissions-Policy: microphone=(self)`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, and `no-cache` for `index.html`
5. **Privacy.** The demo sends nothing anywhere: no analytics, no requests beyond its own files. A microphone provider, when it exists, must keep audio on the device.

## The OBIX packages

AnyTune depends on the published OBIX packages at exactly `0.5.0` — `obix-compiler-*` at build time, `obix-runtime-*` for the native runtime — installed from registry.npmjs.org by `npm ci` (OBIX packages carry no npm scope since the owner's decision D-102 of 2026-09-29; previous names `@obinexusltd/obix-compiler-*`, `@obinexusltd/obix-runtime-*`). A hosted build needs no OBIX checkout. Switching from the earlier `file:../obix-recovery/…` links changed no build output: `dist/app`, `dist/app-native` and `dist/obix-ir` are byte-identical either way.

## github.com/obinexus/anytune

Public since 2026-09-30: MIT `LICENSE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `CONTRIBUTING.md`, the docs, and a history of one commit per step, pushed as it is (branch `main`).
