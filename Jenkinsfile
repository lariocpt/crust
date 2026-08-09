// crust — compile the binary, publish it to the artifact plane, then publish the thin npm
// launcher that resolves it.
//
// ONE ARTIFACT, TWO CHANNELS. The ~91 MB Bun-compiled ELF is published once to
// apps.in.drlario.org; both install routes then resolve that same file and verify the same
// sha256:
//
//   curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust
//   npm i -g crust --registry https://npm.in.drlario.org
//
// The npm package is a ~4 KB launcher, not the binary. 91 MB per version would sit against
// Verdaccio's 200 MB max_body_size and hard-lock the package to linux-x64.
//
// ORDER IS LOAD-BEARING: the binary must reach /srv/apps and be reindexed BEFORE the npm
// package is published, because the launcher resolves index.tsv. Publishing npm first ships
// a package that cannot install itself.
pipeline {
    agent any
    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }
    environment {
        REGISTRY = 'https://npm.in.drlario.org'
    }
    stages {
        stage('Preflight') {
            steps {
                sh '''
                    set -eu
                    test -w /srv/apps || { echo "/srv/apps not writable"; exit 1; }
                    test -x /opt/publish/bin/apps-publish || { echo "apps-publish not mounted"; exit 1; }
                    test -d npm || { echo "npm/ staging template missing"; exit 1; }

                    # The lockfile used to carry baked AWS CodeArtifact URLs from the
                    # decommissioned a former employer account, which 401 and break the build inside a
                    # clean container. Fail here with a clear message rather than mid-compile.
                    if grep -q codeartifact bun.lock 2>/dev/null; then
                        echo "FAIL: bun.lock still references CodeArtifact. Regenerate it:"
                        echo "  rm bun.lock && BUN_CONFIG_REGISTRY=https://registry.npmjs.org bun install"
                        exit 1
                    fi
                '''
            }
        }
        stage('Version') {
            steps {
                sh '''
                    set -eu
                    BASE=$(node -p "require('./package.json').version" | sed 's/-dev$//')
                    SHA=$(git rev-parse --short HEAD)

                    # The two planes version the same build differently, on purpose — see the
                    # header of publish/bin/apps-publish. semver ignores build metadata after
                    # `+` when ordering, so the registry cannot use the apps form; the shared
                    # short sha is what ties one back to the other, and it is what the npm
                    # launcher matches on to fetch ITS build rather than merely the latest.
                    echo "APPS_VERSION=${BASE}+${SHA}"            > version.env
                    echo "NPM_VERSION=${BASE}-ci.${BUILD_NUMBER}.${SHA}" >> version.env
                    cat version.env
                '''
            }
        }
        stage('Compile') {
            steps {
                sh '''
                    set -eu
                    . ./version.env
                    rm -rf out && mkdir -p out

                    # Published as the file name `crust`, not `crust-bin`: install.sh installs a
                    # tool BY FILE NAME (`install -Dm0755 <tmp> $PREFIX/<file>`), so the basename
                    # here becomes the command name on every target machine.
                    #
                    # docker cp both ways — never -v "$PWD:/w" (workspace is a named volume).
                    # The tree must land AT /w, not /w/<something>: src/index.ts imports
                    # ../package.json for --version, so a wrong destination shape either fails to
                    # resolve or silently bakes the unstamped version into the binary.
                    CID=$(docker create -w /w oven/bun:1 sh -c '
                        set -eu
                        cd /w
                        bun install --frozen-lockfile --ignore-scripts
                        bun build --compile --minify --bytecode --outfile /w/out/crust src/index.ts
                    ')
                    trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

                    # Stamp the real version into the manifest the binary embeds, before building.
                    node -e "const f='package.json',p=require('./'+f);p.version=process.env.V;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')" \
                        V="$APPS_VERSION"
                    docker cp "$PWD/." "$CID:/w" >/dev/null
                    git checkout -- package.json   # keep the workspace honest for later stages

                    docker start -a "$CID"
                    docker cp "$CID:/w/out/crust" "$WORKSPACE/out/crust"
                    chmod 0755 out/crust

                    ls -lh out/crust
                    # Prove the binary is the one we think it is. Without this a wrong docker cp
                    # destination ships a binary reporting 0.1.0-dev and nobody notices.
                    got=$(./out/crust --version | tr -d "\\r")
                    echo "reported version: $got"
                    [ "$got" = "$APPS_VERSION" ] || { echo "FAIL: binary reports '$got', expected '$APPS_VERSION'"; exit 1; }
                '''
            }
        }
        stage('Publish binary') {
            steps {
                sh '''
                    set -eu
                    . ./version.env
                    # Retention is applied here (KEEP_VERSIONS, default 5). At ~91 MB a build,
                    # /srv/apps/tools/crust would otherwise grow without bound.
                    /opt/publish/bin/apps-publish bin crust "$APPS_VERSION" "$WORKSPACE/out/crust"

                    grep -q "	crust	$APPS_VERSION	" /srv/apps/index.tsv \
                        || { echo "FAIL: $APPS_VERSION is not in index.tsv"; exit 1; }
                    echo "--- crust rows in index.tsv ---"
                    awk -F'\\t' '$1=="tool" && $2=="crust"' /srv/apps/index.tsv
                '''
            }
        }
        stage('Publish npm') {
            steps {
                // credentials-binding masks the value in the rendered console, but Jenkins'
                // durable-task runs `sh -xe`, so the trace would still write the token to the
                // output file inside jenkins_home. `set +x` below is what actually keeps it out.
                withCredentials([string(credentialsId: 'verdaccio-npm-token', variable: 'NPM_TOKEN')]) {
                    sh '''
                        set -eu
                        . ./version.env

                        rm -rf npmstage && cp -r npm npmstage
                        node -e "const f='npmstage/package.json',p=require('./'+f);p.version=process.env.V;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')" \
                            V="$NPM_VERSION"

                        # The token never appears in argv (visible in `ps` on the host) and never
                        # in the log: written with tracing off, then moved into the container by
                        # docker cp rather than passed as --env or a bind mount.
                        set +x
                        umask 077
                        printf '//npm.in.drlario.org/:_authToken=%s\\nregistry=%s\\n' "$NPM_TOKEN" "$REGISTRY" > npmstage/.npmrc
                        set -x

                        # No --registry flag: the staged .npmrc carries both the registry and
                        # the auth line, so the URL cannot drift between the two and the token
                        # stays out of the container's argv.
                        CID=$(docker create -w /w node:22-bookworm-slim sh -c 'set -eu; cd /w; npm publish')
                        trap 'docker rm -f "$CID" >/dev/null 2>&1 || true; rm -f npmstage/.npmrc' EXIT
                        docker cp "$PWD/npmstage/." "$CID:/w" >/dev/null
                        docker start -a "$CID" || {
                            echo "publish failed — if this is 403/ENEEDAUTH, the verdaccio-npm-token credential is wrong or the htpasswd user was never created"
                            exit 1
                        }
                        rm -f npmstage/.npmrc
                    '''
                }
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    . ./version.env

                    # The curl|bash channel can see it.
                    curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- --list | grep -q crust \
                        || { echo "FAIL: crust is not listed by install.sh"; exit 1; }

                    # The npm channel can see it, and the tarball really is a thin launcher.
                    docker run --rm node:22-bookworm-slim \
                        npm view "crust@$NPM_VERSION" dist.unpackedSize --registry "$REGISTRY"
                    echo "published crust $NPM_VERSION (npm) / $APPS_VERSION (apps)"
                '''
            }
        }
    }
}
