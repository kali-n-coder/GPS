import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "firebase/auth";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { allowedEmailDomain, auth, db, demoMode, firebaseConfigured } from "./firebase";
import type { AppUser, Availability, Role, TeacherLocation } from "./types";

type View = "home" | "chat" | "admin";

const roleLabels: Record<Role, string> = {
  student: "生徒",
  teacher: "教職員",
  admin: "管理者",
};

const availabilityLabels: Record<Availability, string> = {
  available: "対応できます",
  busy: "取り込み中",
  away: "離席中",
};

const demoLocations: TeacherLocation[] = [
  {
    id: "demo-tanaka",
    ownerId: "demo-tanaka",
    displayName: "田中 美咲",
    role: "teacher",
    latitude: 35.68124,
    longitude: 139.76712,
    accuracy: 12,
    placeLabel: "本館 2F・職員室",
    note: "16:30まで在室予定",
    availability: "available",
    sharing: true,
  },
  {
    id: "demo-sato",
    ownerId: "demo-sato",
    displayName: "佐藤 健太",
    role: "teacher",
    latitude: 35.6817,
    longitude: 139.76664,
    accuracy: 18,
    placeLabel: "体育館",
    note: "2年B組の授業中",
    availability: "busy",
    sharing: true,
  },
  {
    id: "demo-yamada",
    ownerId: "demo-yamada",
    displayName: "山田 京子",
    role: "teacher",
    latitude: 35.68082,
    longitude: 139.76758,
    accuracy: 24,
    placeLabel: "南館 1F・保健室",
    note: "",
    availability: "away",
    sharing: true,
  },
];

const demoUsers: AppUser[] = [
  { uid: "demo-student", displayName: "鈴木 ひなた", email: "student@example.ed.jp", role: "student", active: true },
  { uid: "demo-tanaka", displayName: "田中 美咲", email: "tanaka@example.ed.jp", role: "teacher", active: true },
  { uid: "demo-sato", displayName: "佐藤 健太", email: "sato@example.ed.jp", role: "teacher", active: true },
  { uid: "demo-admin", displayName: "管理者", email: "admin@example.ed.jp", role: "admin", active: true },
];

const requestedDemoRole = new URLSearchParams(window.location.search).get("role") as Role | null;
const defaultDemoUser = demoUsers.find((item) => item.role === requestedDemoRole) ?? demoUsers[0];

function Icon({ name, size = 20 }: { name: "pin" | "home" | "chat" | "admin" | "shield" | "logout" | "search" | "send"; size?: number }) {
  const paths = {
    pin: <><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    chat: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5A8 8 0 0 1 3 12c0-5 4-8 9-8s9 3 9 8v3Z"/>,
    admin: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function avatarInitial(name: string) {
  return name.trim().charAt(0) || "?";
}

function timestampLabel(location: TeacherLocation) {
  if (!location.updatedAt) return "たった今";
  const elapsed = Date.now() - location.updatedAt.toMillis();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  return `${Math.floor(minutes / 60)}時間前`;
}

function CampusMap({ locations }: { locations: TeacherLocation[] }) {
  const bounds = useMemo(() => {
    if (!locations.length) return null;
    const lats = locations.map((item) => item.latitude);
    const lngs = locations.map((item) => item.longitude);
    return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
  }, [locations]);

  return (
    <div className="campus-map" aria-label="教職員の位置概略図">
      <div className="map-grid" />
      <span className="building building-a">本館</span>
      <span className="building building-b">南館</span>
      <span className="building building-c">体育館</span>
      {locations.map((location, index) => {
        const latRange = Math.max((bounds?.maxLat ?? 0) - (bounds?.minLat ?? 0), 0.001);
        const lngRange = Math.max((bounds?.maxLng ?? 0) - (bounds?.minLng ?? 0), 0.001);
        const left = 18 + ((location.longitude - (bounds?.minLng ?? 0)) / lngRange) * 64;
        const top = 76 - ((location.latitude - (bounds?.minLat ?? 0)) / latRange) * 54;
        return (
          <a
            key={location.id}
            className={`map-marker marker-${index % 3}`}
            style={{ left: `${left}%`, top: `${top}%` }}
            href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
            target="_blank"
            rel="noreferrer"
            title={`${location.displayName}・${location.placeLabel}`}
          >
            {avatarInitial(location.displayName)}
          </a>
        );
      })}
      {!locations.length && <p className="map-empty">現在、共有中の教職員はいません</p>}
      <div className="map-legend"><span />位置は概略表示です</div>
    </div>
  );
}

function LoginScreen({ onLogin, busy, error }: { onLogin: () => void; busy: boolean; error: string }) {
  return (
    <main className="login-page">
      <div className="login-brand"><span className="brand-mark"><Icon name="pin" size={25} /></span><span>Campus Compass</span></div>
      <section className="login-card">
        <div className="login-illustration"><span className="radar-ring ring-one"/><span className="radar-ring ring-two"/><span className="login-pin"><Icon name="pin" size={38}/></span></div>
        <p className="eyebrow">校内ロケーション</p>
        <h1>先生を、すぐ見つける。</h1>
        <p className="login-copy">教職員が共有した現在地と在席状況を、校内アカウントから確認できます。</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button primary login-button" onClick={onLogin} disabled={busy}>
          <span className="google-g">G</span>{busy ? "ログインしています…" : "Googleでログイン"}
        </button>
        <p className="login-note"><Icon name="shield" size={16}/> 学校が許可したGoogleアカウントのみ利用できます</p>
      </section>
      <p className="login-footer">位置情報は共有を開始した教職員についてのみ表示されます。</p>
    </main>
  );
}

function SetupScreen() {
  return (
    <main className="setup-page">
      <section className="setup-card">
        <span className="brand-mark"><Icon name="pin" size={25}/></span>
        <p className="eyebrow">SETUP REQUIRED</p>
        <h1>Firebaseの接続設定が必要です</h1>
        <p>GitHubリポジトリの Variables にFirebase Web Appの設定値を登録すると、この画面からログイン画面に切り替わります。</p>
        <code>VITE_FIREBASE_API_KEY</code>
        <code>VITE_FIREBASE_AUTH_DOMAIN</code>
        <code>VITE_FIREBASE_PROJECT_ID</code>
        <code>VITE_FIREBASE_APP_ID</code>
        <p className="muted">詳しい設定手順はリポジトリの README.md を参照してください。</p>
      </section>
    </main>
  );
}

function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AppUser | null>(demoMode ? defaultDemoUser : null);
  const [locations, setLocations] = useState<TeacherLocation[]>(demoMode ? demoLocations : []);
  const [users, setUsers] = useState<AppUser[]>(demoMode ? demoUsers : []);
  const [loading, setLoading] = useState(firebaseConfigured);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [availability, setAvailability] = useState<Availability>("available");
  const [placeLabel, setPlaceLabel] = useState("本館 2F・職員室");
  const [note, setNote] = useState("");
  const [sharing, setSharing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ from: "user" | "assistant"; text: string }>>([
    { from: "assistant", text: "こんにちは。将来ここから「田中先生はどこ？」のように質問できる予定です。現在AI機能は準備中です。" },
  ]);
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (!auth || !db) return;
    const firestore = db;
    return onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setLoading(false);
        return;
      }
      try {
        const userRef = doc(firestore, "users", user.uid);
        const snapshot = await getDoc(userRef);
        if (!snapshot.exists()) {
          const newProfile: AppUser = {
            uid: user.uid,
            displayName: user.displayName || "名称未設定",
            email: user.email || "",
            ...(user.photoURL ? { photoURL: user.photoURL } : {}),
            role: "student",
            active: true,
          };
          await setDoc(userRef, { ...newProfile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          setProfile(newProfile);
        } else {
          setProfile({ uid: snapshot.id, ...snapshot.data() } as AppUser);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "ユーザー情報を読み込めませんでした。");
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!db || !profile) return;
    const stopLocations = onSnapshot(collection(db, "locations"), (snapshot) => {
      setLocations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as TeacherLocation).filter((item) => item.sharing));
    }, () => setError("位置情報を読み込めませんでした。管理者にお問い合わせください。"));
    return stopLocations;
  }, [profile]);

  useEffect(() => {
    if (!db || profile?.role !== "admin") return;
    return onSnapshot(collection(db, "users"), (snapshot) => {
      setUsers(snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }) as AppUser));
    });
  }, [profile?.role]);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  const handleLogin = async () => {
    if (!auth) return;
    setAuthBusy(true);
    setError("");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const result = await signInWithPopup(auth, provider);
      if (allowedEmailDomain && !result.user.email?.toLowerCase().endsWith(`@${allowedEmailDomain}`)) {
        await signOut(auth);
        setError(`@${allowedEmailDomain} の学校アカウントでログインしてください。`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ログインに失敗しました。");
    } finally {
      setAuthBusy(false);
    }
  };

  const writePosition = async (position: GeolocationPosition) => {
    if (!profile) return;
    const location: Omit<TeacherLocation, "id" | "updatedAt"> = {
      ownerId: profile.uid,
      displayName: profile.displayName,
      ...(profile.photoURL ? { photoURL: profile.photoURL } : {}),
      role: profile.role === "student" ? "teacher" : profile.role,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: Math.round(position.coords.accuracy),
      placeLabel,
      note,
      availability,
      sharing: true,
    };
    if (demoMode) {
      setLocations((current) => [{ id: profile.uid, ...location }, ...current.filter((item) => item.ownerId !== profile.uid)]);
      return;
    }
    if (db) await setDoc(doc(db, "locations", profile.uid), { ...location, updatedAt: serverTimestamp() });
  };

  const startSharing = () => {
    if (!navigator.geolocation) {
      setError("このブラウザは位置情報に対応していません。");
      return;
    }
    setLocating(true);
    setError("");
    watchId.current = navigator.geolocation.watchPosition(
      async (position) => {
        try {
          await writePosition(position);
          setSharing(true);
        } catch {
          setError("位置情報を保存できませんでした。");
        } finally {
          setLocating(false);
        }
      },
      (geoError) => {
        setLocating(false);
        setError(geoError.code === 1 ? "位置情報の利用が許可されませんでした。ブラウザの設定をご確認ください。" : "現在地を取得できませんでした。");
      },
      { enableHighAccuracy: true, maximumAge: 20_000, timeout: 15_000 },
    );
  };

  const stopSharing = async () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setSharing(false);
    if (demoMode && profile) setLocations((current) => current.filter((item) => item.ownerId !== profile.uid));
    else if (db && profile) await deleteDoc(doc(db, "locations", profile.uid));
  };

  const updateRole = async (uid: string, role: Role) => {
    if (demoMode) {
      setUsers((current) => current.map((item) => item.uid === uid ? { ...item, role } : item));
      return;
    }
    if (db) await updateDoc(doc(db, "users", uid), { role, updatedAt: serverTimestamp() });
  };

  const switchDemoRole = (role: Role) => {
    const next = demoUsers.find((item) => item.role === role) ?? demoUsers[0];
    setProfile(next);
    setView("home");
    setSharing(false);
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    setChatMessages((current) => [...current, { from: "user", text: trimmed }, { from: "assistant", text: "AI機能はまだ接続されていません。Gemini API接続後、この質問に校内データをもとに回答できるようになります。" }]);
    setChatInput("");
  };

  const visibleLocations = locations.filter((location) => {
    const keyword = query.toLowerCase();
    return !keyword || location.displayName.toLowerCase().includes(keyword) || location.placeLabel.toLowerCase().includes(keyword);
  });

  if (!firebaseConfigured && !demoMode) return <SetupScreen />;
  if (loading) return <div className="loading-page"><span className="loading-pin"><Icon name="pin" size={28}/></span><p>読み込んでいます…</p></div>;
  if (!profile) return <LoginScreen onLogin={handleLogin} busy={authBusy} error={error} />;

  const canShare = profile.role === "teacher" || profile.role === "admin";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="pin" size={24}/></span><span><b>Campus</b><small>Compass</small></span></div>
        <nav className="side-nav" aria-label="メインメニュー">
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Icon name="home"/><span>ホーム</span></button>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat"/><span>AIに聞く</span><em>準備中</em></button>
          {profile.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Icon name="admin"/><span>ユーザー管理</span></button>}
        </nav>
        <div className="sidebar-bottom">
          {demoMode && <div className="demo-switch"><span>デモ権限</span><select value={profile.role} onChange={(event) => switchDemoRole(event.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
          <div className="profile-block"><div className="avatar">{avatarInitial(profile.displayName)}</div><div><strong>{profile.displayName}</strong><span>{roleLabels[profile.role]}</span></div></div>
          <button className="logout-button" onClick={() => auth && signOut(auth)} title="ログアウト"><Icon name="logout"/></button>
        </div>
      </aside>

      <main className="main-content">
        <header className="mobile-header"><div className="brand"><span className="brand-mark"><Icon name="pin" size={20}/></span><b>Campus Compass</b></div><div className="avatar small">{avatarInitial(profile.displayName)}</div></header>
        {demoMode && <div className="demo-banner"><span>DEMO</span> Firebase未接続のローカルプレビューです。データは保存されません。</div>}
        {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}

        {view === "home" && (
          <div className="page-wrap">
            <section className="page-heading"><div><p className="eyebrow">TODAY'S CAMPUS</p><h1>こんにちは、{profile.displayName.split(" ")[0]}さん</h1><p>校内にいる先生の現在地を確認できます。</p></div><div className="live-pill"><span/> {locations.length}人が共有中</div></section>

            <section className="privacy-strip"><Icon name="shield" size={21}/><div><strong>位置情報は校内アカウント限定です</strong><span>教職員が共有を開始している間だけ表示されます。位置は目安としてご利用ください。</span></div></section>

            {canShare && (
              <section className="share-panel">
                <div className="share-title"><div className={sharing ? "share-indicator on" : "share-indicator"}><Icon name="pin"/></div><div><h2>自分の位置を共有</h2><p>{sharing ? "現在、あなたの位置を共有しています。" : "共有はいつでも停止できます。"}</p></div></div>
                <div className="share-fields">
                  <label>校内表示<span>GPSと一緒に表示されます</span><select value={placeLabel} onChange={(event) => setPlaceLabel(event.target.value)}><option>本館 2F・職員室</option><option>本館 1F・事務室</option><option>南館 1F・保健室</option><option>南館 3F・理科室</option><option>体育館</option><option>グラウンド</option><option>校外</option></select></label>
                  <label>在席状況<span>生徒への案内</span><select value={availability} onChange={(event) => setAvailability(event.target.value as Availability)}>{Object.entries(availabilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="note-field">ひとこと<span>任意</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={80} placeholder="例：16:30まで在室予定" /></label>
                  {sharing ? <button className="button stop" onClick={stopSharing}>共有を停止</button> : <button className="button primary share-button" onClick={startSharing} disabled={locating}><Icon name="pin" size={18}/>{locating ? "現在地を取得中…" : "現在地を共有"}</button>}
                </div>
              </section>
            )}

            <div className="dashboard-grid">
              <section className="map-card"><div className="section-title"><div><p className="eyebrow">CAMPUS MAP</p><h2>校内マップ</h2></div><span className="map-count">{visibleLocations.length} locations</span></div><CampusMap locations={visibleLocations}/></section>
              <section className="people-card"><div className="section-title"><div><p className="eyebrow">FACULTY</p><h2>先生を探す</h2></div></div><label className="search-box"><Icon name="search" size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・場所で検索" /></label><div className="teacher-list">
                {visibleLocations.map((location) => <article className="teacher-row" key={location.id}><div className="avatar teacher-avatar">{avatarInitial(location.displayName)}<span className={`status-dot ${location.availability}`}/></div><div className="teacher-info"><div><strong>{location.displayName}</strong><span className={`availability ${location.availability}`}>{availabilityLabels[location.availability]}</span></div><p><Icon name="pin" size={14}/>{location.placeLabel}</p>{location.note && <small>{location.note}</small>}</div><div className="updated"><span>{timestampLabel(location)}</span><a href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`} target="_blank" rel="noreferrer">地図 ↗</a></div></article>)}
                {!visibleLocations.length && <div className="empty-state"><Icon name="pin" size={30}/><p>条件に合う先生が見つかりません</p></div>}
              </div></section>
            </div>
          </div>
        )}

        {view === "chat" && (
          <div className="page-wrap narrow-page"><section className="page-heading"><div><p className="eyebrow">COMING SOON</p><h1>AIに居場所を聞く</h1><p>将来、Gemini APIと接続するためのチャット画面です。</p></div></section><section className="chat-card"><div className="chat-notice"><span>β</span><div><strong>AI機能は準備中です</strong><p>現在は質問を送信しても位置情報の検索は行われません。</p></div></div><div className="messages">{chatMessages.map((message, index) => <div key={index} className={`message ${message.from}`}><span>{message.from === "assistant" ? "AI" : avatarInitial(profile.displayName)}</span><p>{message.text}</p></div>)}</div><div className="suggestions"><span>質問例</span><button onClick={() => setChatInput("田中先生はどこにいますか？")}>田中先生はどこ？</button><button onClick={() => setChatInput("今、対応できる先生を教えて")}>対応できる先生は？</button></div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="先生の名前や場所を入力…"/><button aria-label="送信"><Icon name="send"/></button></form></section></div>
        )}

        {view === "admin" && profile.role === "admin" && (
          <div className="page-wrap"><section className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>ユーザー管理</h1><p>利用者の権限と利用状態を管理します。</p></div></section><section className="admin-card"><div className="admin-summary"><div><span>{users.length}</span><small>登録ユーザー</small></div><div><span>{users.filter((user) => user.role === "teacher").length}</span><small>教職員</small></div><div><span>{users.filter((user) => user.role === "admin").length}</span><small>管理者</small></div></div><div className="user-table-wrap"><table><thead><tr><th>ユーザー</th><th>メール</th><th>権限</th><th>状態</th></tr></thead><tbody>{users.map((user) => <tr key={user.uid}><td><div className="table-user"><span className="avatar small">{avatarInitial(user.displayName)}</span><strong>{user.displayName}</strong></div></td><td>{user.email}</td><td><select value={user.role} onChange={(event) => updateRole(user.uid, event.target.value as Role)} disabled={user.uid === profile.uid}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><span className="active-label"><i/>有効</span></td></tr>)}</tbody></table></div><p className="admin-note"><Icon name="shield" size={16}/>最初の管理者はFirebase Consoleから手動で設定してください。自分自身の管理者権限は画面から変更できません。</p></section></div>
        )}
      </main>

      <nav className="bottom-nav" aria-label="モバイルメニュー"><button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Icon name="home"/><span>ホーム</span></button><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat"/><span>AIに聞く</span></button>{profile.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Icon name="admin"/><span>管理</span></button>}</nav>
    </div>
  );
}

export default App;
