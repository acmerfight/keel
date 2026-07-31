# OAuth release artifacts

`client-metadata.json` is Keel's public OAuth Client ID Metadata Document. Its
published URL is part of the client identity, so the repository copy and the
GitHub Pages artifact must remain identical.

## Release gate

From `keel/`, publish the committed `docs/` tree and verify the exact artifact
before releasing a build that changes the metadata document or its runtime
projection:

```sh
git -C .. fetch origin gh-pages
git -C .. subtree split --prefix=keel/docs -b deploy-cimd-pages
git -C .. push --force-with-lease origin deploy-cimd-pages:gh-pages
git -C .. branch -D deploy-cimd-pages
curl -fsS https://acmerfight.github.io/keel/oauth/client-metadata.json \
  | diff -u docs/oauth/client-metadata.json -
```

The release is blocked unless the URL returns HTTP 200 as JSON and the final
`diff` is empty. `tests/mcp/cimd.test.ts` separately owns the invariant between
the repository document and Keel's typed runtime callback registry.
