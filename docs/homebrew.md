# Personal Homebrew tap

The application lives in `sxlxc/texvu`. The tap repository is `sxlxc/homebrew-texvu`. To release, set the version in package.json and package-lock.json, commit the source, and tag the release.

```sh
version=$(node -p "require('./package.json').version")
git tag "v$version"
git push origin HEAD "v$version"
mkdir -p ../homebrew-texvu/Formula
sed -e "s/vVERSION/v$version/" -e "s/REVISION/$(git rev-parse "v$version^{commit}")/" \
  contrib/homebrew/Formula/texvu.rb.template > ../homebrew-texvu/Formula/texvu.rb
```

Commit and push the generated formula in the tap repository. Verify with `brew install sxlxc/texvu/texvu` and `brew test sxlxc/texvu/texvu`.

The formula bundles the locked WebSocket dependency as a Homebrew resource. When updating `ws`, update its resource URL and SHA-256 in the template. After installing the generated formula, run `brew services start texvu`, then `texvu --no-open main.pdf` to register a document.
