# Teachers-position（ティーポジ）

校内アカウントで、教職員が選択して共有した校内の場所・在席状況をリアルタイムに確認するWebアプリです。GitHub Pagesでフロントエンドを公開し、Firebase AuthenticationとCloud Firestoreを利用します。

## 現在の機能

- Googleアカウント認証
- `student` / `teacher` / `admin` の3権限
- 教職員本人による、校内の場所選択と共有の開始・停止
- 選択場所、在席状況、ひとことのリアルタイム表示
- 名前・場所検索と校内マップ表示
- 管理者によるユーザー権限変更
- 管理者による場所選択肢・有効状態・マップ位置の編集
- 将来Gemini APIを接続するためのチャットUI（現在は未接続）
- GitHub ActionsによるGitHub Pages自動デプロイ

## 権限

| 権限 | 位置の閲覧 | 自分の位置共有 | ユーザー管理 |
|---|---:|---:|---:|
| student | ○ | — | — |
| teacher | ○ | ○ | — |
| admin | ○ | ○ | ○ |

新規ログインユーザーは必ず `student` で作成されます。`teacher` / `admin` への昇格は管理者だけが行えます。

## ローカル開発

Node.js 24以上を推奨します。

```bash
npm install
cp .env.example .env.local
npm run dev
```

Firebase設定がない開発環境では、自動的にデモモードになります。画面左下のセレクトボックスで3権限を切り替えられます。デモモードは本番ビルドでは有効になりません。

## Firebase初期設定

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成します。
2. Authentication → Sign-in method で Google を有効化します。
3. Authentication → Settings → Authorized domains に `kali-n-coder.github.io` を追加します。
4. Firestore Databaseを本番モードで作成します（校内に近いリージョンを推奨）。
5. Firestore Consoleで `config/auth` ドキュメントを作り、文字列フィールド `allowedEmailDomain` に学校のGoogle Workspaceドメイン（例: `example.ed.jp`）、`initialAdminEmail` に最初の管理者メールを設定します。この設定がない間は全アクセスが拒否されます。
6. Webアプリを追加し、表示されたFirebase構成値を控えます。
7. ルールをデプロイします。

```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy --only firestore:rules,firestore:indexes
```

### 最初の管理者

`config/auth` の `initialAdminEmail` と一致するユーザーは、初回ログイン時に自動で `admin` として登録されます。以降の権限変更はアプリの「ユーザー管理」から行えます。

初期管理者が登録された後に `initialAdminEmail` を変更しても、既存ユーザーの権限は自動変更されません。

### 学校ドメインを後から変更する

Firestoreの `config/auth.allowedEmailDomain` と、GitHub Repository Variableの `VITE_ALLOWED_EMAIL_DOMAIN` を同じ値に更新し、GitHub Pagesを再デプロイします。既存ユーザーを無効にする必要がある場合は、管理画面から対象ユーザーの状態も変更してください。

## GitHub Pages公開設定

GitHubの `Settings → Secrets and variables → Actions → Variables` に、次のRepository variablesを登録します。Firebase Web AppのAPIキーはクライアント識別用であり秘密鍵ではありませんが、Firestoreルールは必ずデプロイしてください。

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_ALLOWED_EMAIL_DOMAIN`

次に `Settings → Pages → Build and deployment → Source` で **GitHub Actions** を選択します。`main` へのpushで `.github/workflows/deploy-pages.yml` が実行され、次のURLへ公開されます。

`https://kali-n-coder.github.io/GPS/`

## データ構造

```text
config/auth
  allowedEmailDomain, initialAdminEmail

config/places
  items[], placeIds[], updatedAt

users/{uid}
  uid, displayName, email, photoURL, role, active, createdAt, updatedAt

locations/{uid}
  ownerId, displayName, photoURL, role, placeId, note,
  availability, sharing, updatedAt
```

## 場所共有と運用上の注意

- GPSやブラウザの位置情報APIは使用しません。
- 教職員が管理者の設定した選択肢から自分のいる場所を選び、共有します。
- 管理者はアプリの「管理 → 場所の選択肢」から、場所名・利用状態・マップ表示位置を変更できます。
- 共有を停止するとFirestoreの場所ドキュメントを削除します。
- 利用開始前に学校の個人情報保護方針、保護者・教職員への説明、保存期間、緊急時対応を確認してください。
- 場所の履歴は保存しません。将来履歴を追加する場合は、目的・保存期間・閲覧権限を別途設計してください。

## Gemini API接続時の方針

APIキーをGitHub Pagesへ埋め込んではいけません。Firebase FunctionsまたはCloud Runを経由し、認証済みユーザーの権限を検証してから、必要最小限の選択場所だけをGeminiへ渡してください。現時点のチャット欄はUIのみで、外部APIへの送信は行いません。
