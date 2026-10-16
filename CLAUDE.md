# 작업 지침

## 개인정보 규칙 (항상 지킴)

- 코드·문서·커밋 메시지·PR 제목과 본문·이슈·댓글에 사이트 도메인, GitHub 계정 이름, 저장소 이름, 본명, 개인·회사 이메일을 적지 않는다.
- 커밋 작성자 이메일은 GitHub 비공개 주소(`…@users.noreply.github.com`)만 쓴다. 커밋 전에 `git log --format='%ae %ce'`로 확인한다.
- 사이트 주소는 코드에 적지 않는다. 코드에는 `https://site-url.invalid` 자리표시만 두고, 배포 워크플로가 `actions/configure-pages`의 `base_url`을 받아 빌드 결과물에서 바꿔 넣는다. 자리표시가 남으면 배포를 멈춘다.
- `CNAME` 파일을 두지 않는다. 배포는 GitHub Actions로 하고, 도메인은 저장소 Settings → Pages에만 둔다.
- README는 두지 않거나 서비스 이름·주소 없이 쓴다. `package.json`을 만들면 `name`도 일반 이름으로 한다.
- 수집 봇 User-Agent에 사이트 주소를 넣지 않는다.
- 저장소에 넣는 이미지는 sharp로 다시 저장해 EXIF·XMP·IPTC 정보를 지운다.
- API 키 등은 GitHub Secrets에만 넣고 대화·코드·로그에 쓰지 않는다. 워크플로에서 비밀 값을 출력하지 않는다.
- 다른 운영 사이트로 가는 링크를 넣지 않는다.
- 확인용 임시 파일(probe 등)은 PR 전에 지운다.

## 커밋과 병합

- 클라우드 세션의 기본 커밋 이메일은 비공개 주소가 아니다. 첫 커밋 전에 기존 기록에 있는 비공개 주소로 맞춘다.

  ```sh
  addr=$(git log --format='%ae' | grep '@users.noreply.github.com$' | grep -v '\[bot\]' | head -1)
  git config user.email "$addr"
  git config user.name "$(git log -1 --format='%an' --author="$addr")"
  ```

- PR은 Squash 또는 Rebase로 합친다. "Create a merge commit"은 병합 메시지(`Merge pull request #N from …`)에 계정 이름을 남긴다.
- 커밋 메시지에 GitHub 링크(계정·저장소 경로가 들어간 주소)를 쓰지 않는다.

## 자동 검사

- `.github/workflows/privacy-check.yml`이 push와 PR마다 `.github/scripts/privacy_check.py`를 실행한다.
  - 파일: 금지 문자열, `*.github.io` 주소, `CNAME`, probe 파일, 이미지의 EXIF·XMP·IPTC
  - 커밋: 작성자·커미터 이메일, 병합 메시지의 계정 이름, 커밋 메시지의 금지 문자열
- 금지 문자열은 Secrets의 `PRIVACY_PATTERNS`(한 줄에 하나)에만 있다. 값을 코드·대화·로그에 옮기지 않는다.
- push 전에 로컬에서 먼저 돌린다. 로컬에는 `PRIVACY_PATTERNS`가 없어 금지 문자열만 건너뛰고 나머지는 그대로 검사한다.

  ```sh
  python3 .github/scripts/privacy_check.py files
  python3 .github/scripts/privacy_check.py commits origin/main..HEAD
  ```

- 검사가 실패하면 원인을 고친다. 통과시키려고 검사 스크립트나 워크플로를 약하게 바꾸지 않는다.

## 이 저장소

- 의존성 없는 정적 사이트다. `scripts/build.mjs`가 `src/`를 `_site/`로 복사하고, `.github/workflows/pages.yml`이 그 결과를 GitHub Pages로 배포한다.
- `pages.yml`이 `base_url`을 `SITE_URL` 환경 변수로 넘기면 빌드가 `https://site-url.invalid` 자리표시를 실제 주소로 바꾼다. 로컬에서 `SITE_URL` 없이 빌드하면 자리표시가 그대로 남는다.
- 로컬 확인: `node scripts/build.mjs` 후 `_site/`를 정적 서버로 연다.
