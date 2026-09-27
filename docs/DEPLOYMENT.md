# Deployment: prepared, not done

AnyTune isn't deployed, and its repository isn't published. This document prepares both for the owner's separate authorisation. **None of the steps below has been taken.**

## What would be deployed

`npm run build` writes a static site to `dist/app`:

- `index.html`
- `assets/index-<hash>.js`: the application and Vue's runtime, about 89 kB, 33 kB gzipped
- `assets/index-<hash>.css`
- `obix-runtime-manifest.json`

It needs no server code, no Obicall and no database. Any static host serves it.

## anytune.obinexus.org (proposed)

1. **Hosting.** A static host serving `dist/app` from the repository's default branch, built with Node ≥ 26 and `npm ci && npm run build`. Examples: GitHub Pages with an Actions workflow, Cloudflare Pages, or Netlify. The build needs the OBIX compiler packages (see *Prerequisite* below).
2. **DNS.** A `CNAME` record `anytune.obinexus.org` → the host's target, added by whoever administers `obinexus.org`.
3. **HTTPS.** Required: the future microphone input needs a secure context (`getUserMedia`). All the hosts above issue certificates.
4. **Headers** (suggested):
   - `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
   - `Permissions-Policy: microphone=(self)`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, and `no-cache` for `index.html`
5. **Privacy.** The demo sends nothing anywhere: no analytics, no requests beyond its own files. A microphone provider, when it exists, must keep audio on the device.

## Prerequisite: the OBIX compiler packages

`package.json` links the OBIX compiler as `file:../obix-recovery/compiler/…`. A build therefore needs the OBIX monorepo checked out beside AnyTune, with its compiler built (`npm ci && npm run build` there).

For a public repository and a hosted build, one of these is needed, and each needs the owner's authorisation:

- **publish** `@obinexusltd/obix-compiler-*` (scoped; never an unscoped package named `obix`) and depend on the published versions; or
- **check out** the OBIX monorepo in the build (a pinned commit), and build its compiler first.

## github.com/obinexus/anytune (prepared)

The repository is ready to be pushed as it is: MIT `LICENSE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `CONTRIBUTING.md`, the docs, and a history of one commit per step. It has **no remote**. Creating the GitHub repository and pushing are left to the owner.
