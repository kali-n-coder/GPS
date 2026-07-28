import { useEffect, useState } from "react";
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
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import QRCode from "qrcode";
import { aiModel, allowedEmailDomain, auth, db, demoMode, firebaseConfigured } from "./firebase";
import type { AppUser, Availability, CampusPlace, Role, TeacherLocation } from "./types";

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

const defaultCampusPlaces: CampusPlace[] = [
  { id: "staff-room", label: "本館 2F・職員室", left: 49, top: 29, active: true },
  { id: "office", label: "本館 1F・事務室", left: 62, top: 37, active: true },
  { id: "nurse-room", label: "南館 1F・保健室", left: 73, top: 70, active: true },
  { id: "science-room", label: "南館 3F・理科室", left: 67, top: 62, active: true },
  { id: "gym", label: "体育館", left: 21, top: 73, active: true },
  { id: "ground", label: "グラウンド", left: 17, top: 45, active: true },
  { id: "off-campus", label: "校外", left: 87, top: 19, active: true },
];

const demoLocations: TeacherLocation[] = [
  {
    id: "demo-tanaka",
    ownerId: "demo-tanaka",
    displayName: "田中 美咲",
    role: "teacher",
    placeId: "staff-room",
    note: "16:30まで在室予定",
    availability: "available",
    sharing: true,
    availabilityUntil: Timestamp.fromDate(new Date(Date.now() + 75 * 60_000)),
    sharingExpiresAt: Timestamp.fromDate(new Date(Date.now() + 2 * 60 * 60_000)),
    updatedAt: Timestamp.fromDate(new Date(Date.now() - 4 * 60_000)),
  },
  {
    id: "demo-sato",
    ownerId: "demo-sato",
    displayName: "佐藤 健太",
    role: "teacher",
    placeId: "gym",
    note: "2年B組の授業中",
    availability: "busy",
    sharing: true,
    availabilityUntil: Timestamp.fromDate(new Date(Date.now() + 25 * 60_000)),
    sharingExpiresAt: Timestamp.fromDate(new Date(Date.now() + 90 * 60_000)),
    updatedAt: Timestamp.fromDate(new Date(Date.now() - 45 * 60_000)),
  },
  {
    id: "demo-yamada",
    ownerId: "demo-yamada",
    displayName: "山田 京子",
    role: "teacher",
    placeId: "nurse-room",
    note: "",
    availability: "away",
    sharing: true,
    availabilityUntil: Timestamp.fromDate(new Date(Date.now() + 40 * 60_000)),
    sharingExpiresAt: Timestamp.fromDate(new Date(Date.now() + 3 * 60 * 60_000)),
    updatedAt: Timestamp.fromDate(new Date(Date.now() - 8 * 60_000)),
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
const requestedDemoView = new URLSearchParams(window.location.search).get("view") as View | null;
const defaultDemoView: View = requestedDemoView && ["home", "chat", "admin"].includes(requestedDemoView) ? requestedDemoView : "home";
const requestedPlaceId = new URLSearchParams(window.location.search).get("place");
const staleAfterMs = 30 * 60_000;

function toLocalDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultAvailabilityUntil() {
  return toLocalDateTimeInput(new Date(Date.now() + 60 * 60_000));
}

function sharingExpiry(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

function formatTime(timestamp?: Timestamp) {
  if (!timestamp) return "";
  return timestamp.toDate().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function isExpired(location: TeacherLocation, now: number) {
  return Boolean(location.sharingExpiresAt && location.sharingExpiresAt.toMillis() <= now);
}

function isStale(location: TeacherLocation, now: number) {
  return Boolean(location.updatedAt && now - location.updatedAt.toMillis() >= staleAfterMs);
}

async function compressMapImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選択してください。");
  if (file.size > 12 * 1024 * 1024) throw new Error("画像は12MB以下にしてください。");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      image.src = objectUrl;
    });
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像を処理できませんでした。");
    context.fillStyle = "#f5f4ed";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.82;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 700_000 && quality > 0.42) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > 700_000) throw new Error("画像を十分に圧縮できません。より小さい画像を選択してください。");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

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

function timestampLabel(location: TeacherLocation, now = Date.now()) {
  if (!location.updatedAt) return "たった今";
  const elapsed = now - location.updatedAt.toMillis();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  return `${Math.floor(minutes / 60)}時間前`;
}

function placeLabel(location: TeacherLocation, places: CampusPlace[]) {
  return places.find((item) => item.id === location.placeId)?.label ?? "廃止された場所";
}

type AiLocationRequest = {
  prompt?: string;
  aliases?: Map<string, string>;
  localAnswer?: string;
};

function nameMatchesQuestion(displayName: string, question: string) {
  const compactQuestion = question.replace(/[\s　]/g, "");
  const variants = [displayName, ...displayName.split(/[\s　]+/)]
    .map((value) => value.replace(/[\s　]/g, ""))
    .filter((value) => value.length >= 2);
  return variants.some((value) => compactQuestion.includes(value));
}

function buildAiLocationRequest(question: string, locations: TeacherLocation[], places: CampusPlace[], now: number): AiLocationRequest {
  if (!locations.length) {
    return { localAnswer: "現在、場所を共有している教職員はいません。" };
  }

  const matchedTeachers = locations.filter((location) => nameMatchesQuestion(location.displayName, question));
  const matchedPlaceIds = places
    .filter((place) => {
      const shortLabel = place.label.split("・").at(-1) || place.label;
      return question.includes(place.label) || question.includes(shortLabel);
    })
    .map((place) => place.id);
  const asksAvailability = /(対応|話せ|空いて|会える|相談|取り込み)/.test(question);
  const asksEveryone = /(全員|みんな|先生たち|教職員)/.test(question);

  let targetLocations: TeacherLocation[] = [];
  let intent = "";
  if (matchedTeachers.length) {
    targetLocations = matchedTeachers;
    intent = "指定された教職員の現在地と対応状況を案内する";
  } else if (matchedPlaceIds.length) {
    targetLocations = locations.filter((location) => matchedPlaceIds.includes(location.placeId));
    if (!targetLocations.length) return { localAnswer: "その場所を共有している教職員は現在いません。" };
    intent = "指定された場所にいる教職員を案内する";
  } else if (asksAvailability) {
    targetLocations = locations;
    intent = "現在対応できる教職員を優先して案内する";
  } else if (asksEveryone) {
    targetLocations = locations;
    intent = "現在場所を共有している教職員を簡潔に案内する";
  } else {
    return { localAnswer: "共有中の先生の名前、場所、または「対応できる先生」のように質問してください。" };
  }

  const aliases = new Map<string, string>();
  const context = targetLocations.map((location, index) => {
    const alias = `STAFF_${index + 1}`;
    aliases.set(alias, location.displayName);
    const ended = Boolean(location.availabilityUntil && location.availabilityUntil.toMillis() <= now);
    const status = ended ? "対応予定終了" : availabilityLabels[location.availability];
    const until = location.availabilityUntil ? formatTime(location.availabilityUntil) : "未設定";
    const freshness = isStale(location, now) ? "30分以上更新なし・要確認" : "更新情報は新しい";
    return `${alias} | 場所: ${placeLabel(location, places)} | 状況: ${status} | 対応予定: ${until}まで | 鮮度: ${freshness}`;
  }).join("\n");

  return {
    aliases,
    prompt: `あなたは学校内Webアプリ「ティーポジ」の案内AIです。
以下の匿名化された現在データだけを使い、日本語で1〜3文の簡潔な回答をしてください。
推測やデータにない情報は追加しないでください。30分以上更新がない情報には「要確認」と添えてください。
教職員の識別子は必ず STAFF_1 の形式のまま回答し、実名を推測しないでください。

利用者の意図: ${intent}
現在データ:
${context}`,
  };
}

function restoreTeacherNames(text: string, aliases: Map<string, string>) {
  let restored = text.replace(/\*\*/g, "").trim();
  for (const [alias, displayName] of aliases) restored = restored.replaceAll(alias, displayName);
  return restored.slice(0, 600);
}

function demoAnswer(aliases: Map<string, string>, locations: TeacherLocation[], places: CampusPlace[]) {
  const names = [...aliases.values()];
  return names.map((name) => {
    const location = locations.find((item) => item.displayName === name);
    return location ? `${name}は現在「${placeLabel(location, places)}」です。` : "";
  }).filter(Boolean).join(" ") || "条件に合う教職員は見つかりませんでした。";
}

function CampusMap({ locations, places, mapImageUrl = "" }: { locations: TeacherLocation[]; places: CampusPlace[]; mapImageUrl?: string }) {
  return (
    <div className={`campus-map${mapImageUrl ? " has-floor-plan" : ""}`} aria-label="教職員の位置概略図">
      {mapImageUrl ? <img className="floor-plan-image" src={mapImageUrl} alt="管理者が登録した校内マップ" /> : <><div className="map-grid" /><span className="building building-a">本館</span><span className="building building-b">南館</span><span className="building building-c">体育館</span></>}
      {locations.map((location, index) => {
        const place = places.find((item) => item.id === location.placeId) ?? defaultCampusPlaces[0];
        const samePlaceIndex = locations.slice(0, index).filter((item) => item.placeId === location.placeId).length;
        const left = place.left + (samePlaceIndex % 3) * 4;
        const top = place.top + Math.floor(samePlaceIndex / 3) * 6;
        return (
          <span
            key={location.id}
            className={`map-marker marker-${index % 3}`}
            style={{ left: `${left}%`, top: `${top}%` }}
            title={`${location.displayName}・${placeLabel(location, places)}`}
          >
            {avatarInitial(location.displayName)}
          </span>
        );
      })}
      {!locations.length && <p className="map-empty">現在、共有中の教職員はいません</p>}
      <div className="map-legend"><span />選択された場所を表示</div>
    </div>
  );
}

function LoginScreen({ onLogin, busy, error }: { onLogin: () => void; busy: boolean; error: string }) {
  return (
    <main className="login-page">
      <div className="login-brand"><span className="brand-mark"><Icon name="pin" size={25} /></span><span>Teachers-position <small>ティーポジ</small></span></div>
      <section className="login-card">
        <div className="login-illustration"><span className="radar-ring ring-one"/><span className="radar-ring ring-two"/><span className="login-pin"><Icon name="pin" size={38}/></span></div>
        <p className="eyebrow">TEACHERS LOCATION</p>
        <h1>先生を、すぐ見つける。</h1>
        <p className="login-copy">教職員が選択して共有した校内の場所と在席状況を、校内アカウントから確認できます。</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button primary login-button" onClick={onLogin} disabled={busy}>
          <span className="google-g">G</span>{busy ? "ログインしています…" : "Googleでログイン"}
        </button>
        <p className="login-note"><Icon name="shield" size={16}/> 学校が許可したGoogleアカウントのみ利用できます</p>
      </section>
      <p className="login-footer">教職員が選択した校内の場所だけを表示します。GPSは使用しません。</p>
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
  const [places, setPlaces] = useState<CampusPlace[]>(defaultCampusPlaces);
  const [placesLoaded, setPlacesLoaded] = useState(demoMode);
  const [placesDirty, setPlacesDirty] = useState(false);
  const [placesSaving, setPlacesSaving] = useState(false);
  const [mapImageUrl, setMapImageUrl] = useState("");
  const [mapFileName, setMapFileName] = useState("");
  const [mapDirty, setMapDirty] = useState(false);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapProcessing, setMapProcessing] = useState(false);
  const [loading, setLoading] = useState(firebaseConfigured);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(demoMode ? defaultDemoView : "home");
  const [query, setQuery] = useState("");
  const [availability, setAvailability] = useState<Availability>("available");
  const [placeId, setPlaceId] = useState(requestedPlaceId || "staff-room");
  const [availabilityUntil, setAvailabilityUntil] = useState(defaultAvailabilityUntil);
  const [shareDurationMinutes, setShareDurationMinutes] = useState(120);
  const [note, setNote] = useState("");
  const [sharing, setSharing] = useState(false);
  const [savingPlace, setSavingPlace] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ from: "user" | "assistant"; text: string }>>([
    { from: "assistant", text: "こんにちは。「田中先生はどこ？」「今、対応できる先生は？」のように質問してください。" },
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!profile) return;
    setSharing(locations.some((item) => item.ownerId === profile.uid && item.sharing && !isExpired(item, now)));
  }, [locations, now, profile]);

  useEffect(() => {
    if (!db || !profile || demoMode) return;
    const firestore = db;
    locations.filter((item) => isExpired(item, now)).forEach((item) => {
      void deleteDoc(doc(firestore, "locations", item.id)).catch(() => undefined);
    });
  }, [locations, now, profile]);

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
          const authConfigSnapshot = await getDoc(doc(firestore, "config", "auth"));
          const initialAdminEmail = authConfigSnapshot.exists()
            ? String(authConfigSnapshot.data().initialAdminEmail || "").toLowerCase()
            : "";
          const initialRole: Role = user.email?.toLowerCase() === initialAdminEmail ? "admin" : "student";
          const newProfile: AppUser = {
            uid: user.uid,
            displayName: user.displayName || "名称未設定",
            email: user.email || "",
            ...(user.photoURL ? { photoURL: user.photoURL } : {}),
            role: initialRole,
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
      const loadedLocations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as TeacherLocation).filter((item) => item.sharing);
      setLocations(loadedLocations);
      setSharing(loadedLocations.some((item) => item.ownerId === profile.uid));
    }, () => setError("場所情報を読み込めませんでした。管理者にお問い合わせください。"));
    return stopLocations;
  }, [profile]);

  useEffect(() => {
    if (!db || !profile) return;
    return onSnapshot(doc(db, "config", "places"), (snapshot) => {
      if (!snapshot.exists()) return;
      const items = snapshot.data().items;
      if (!Array.isArray(items)) return;
      const loaded = items
        .filter((item) => item && typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          left: Number(item.left),
          top: Number(item.top),
          active: item.active !== false,
        })) as CampusPlace[];
      if (loaded.length) {
        setPlaces(loaded);
        setPlacesLoaded(true);
        setPlacesDirty(false);
        if (requestedPlaceId && loaded.some((place) => place.id === requestedPlaceId && place.active)) {
          setPlaceId(requestedPlaceId);
        }
      }
    }, () => setError("場所の選択肢を読み込めませんでした。"));
  }, [profile]);

  useEffect(() => {
    const activePlaces = places.filter((place) => place.active);
    if (placesLoaded && activePlaces.length && !activePlaces.some((place) => place.id === placeId)) {
      setPlaceId(activePlaces[0].id);
    }
  }, [places, placeId, placesLoaded]);

  useEffect(() => {
    if (!db || !profile) return;
    return onSnapshot(doc(db, "config", "map"), (snapshot) => {
      const data = snapshot.data();
      setMapImageUrl(typeof data?.imageDataUrl === "string" ? data.imageDataUrl : "");
      setMapFileName(typeof data?.fileName === "string" ? data.fileName : "");
      setMapDirty(false);
    }, () => setError("校内マップ画像を読み込めませんでした。"));
  }, [profile]);

  useEffect(() => {
    if (!db || profile?.role !== "admin") return;
    return onSnapshot(collection(db, "users"), (snapshot) => {
      setUsers(snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }) as AppUser));
    });
  }, [profile?.role]);

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

  const shareSelectedPlace = async () => {
    if (!profile) return;
    const selectedPlace = places.find((item) => item.id === placeId && item.active);
    if (!selectedPlace) {
      setError("共有する場所を選択してください。");
      return;
    }
    const availabilityUntilDate = new Date(availabilityUntil);
    if (!availabilityUntil || Number.isNaN(availabilityUntilDate.getTime()) || availabilityUntilDate.getTime() <= Date.now()) {
      setError("対応予定の終了時刻は、現在より後の時刻を選択してください。");
      return;
    }
    const expiresAt = sharingExpiry(shareDurationMinutes);
    setSavingPlace(true);
    setError("");
    const location: Omit<TeacherLocation, "id" | "updatedAt"> = {
      ownerId: profile.uid,
      displayName: profile.displayName,
      ...(profile.photoURL ? { photoURL: profile.photoURL } : {}),
      role: profile.role === "student" ? "teacher" : profile.role,
      placeId: selectedPlace.id,
      note,
      availability,
      sharing: true,
      availabilityUntil: Timestamp.fromDate(availabilityUntilDate),
      sharingExpiresAt: Timestamp.fromDate(expiresAt),
    };
    if (demoMode) {
      setLocations((current) => [{ id: profile.uid, ...location, updatedAt: Timestamp.now() }, ...current.filter((item) => item.ownerId !== profile.uid)]);
      setSharing(true);
      setSavingPlace(false);
      return;
    }
    try {
      if (db) await setDoc(doc(db, "locations", profile.uid), { ...location, updatedAt: serverTimestamp() });
      setSharing(true);
    } catch {
      setError("場所を保存できませんでした。");
    } finally {
      setSavingPlace(false);
    }
  };

  const stopSharing = async () => {
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

  const updatePlace = (id: string, patch: Partial<CampusPlace>) => {
    setPlaces((current) => current.map((place) => place.id === id ? { ...place, ...patch } : place));
    setPlacesDirty(true);
  };

  const addPlace = () => {
    const id = `place-${Date.now().toString(36)}`;
    setPlaces((current) => [...current, { id, label: "新しい場所", left: 50, top: 50, active: true }]);
    setPlacesDirty(true);
  };

  const removePlace = (id: string) => {
    setPlaces((current) => current.filter((place) => place.id !== id));
    setPlacesDirty(true);
  };

  const savePlaces = async () => {
    const normalized = places.map((place) => ({
      ...place,
      label: place.label.trim(),
      left: Math.round(Math.min(92, Math.max(8, place.left))),
      top: Math.round(Math.min(88, Math.max(12, place.top))),
    }));
    if (!normalized.length || normalized.some((place) => !place.label) || !normalized.some((place) => place.active)) {
      setError("場所名を入力し、少なくとも1つを有効にしてください。");
      return;
    }
    if (new Set(normalized.map((place) => place.label)).size !== normalized.length) {
      setError("同じ場所名は複数登録できません。");
      return;
    }
    setPlacesSaving(true);
    setError("");
    try {
      if (demoMode) {
        setPlaces(normalized);
        setPlacesDirty(false);
      } else if (db) {
        await setDoc(doc(db, "config", "places"), {
          items: normalized,
          placeIds: normalized.filter((place) => place.active).map((place) => place.id),
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      setError("場所の選択肢を保存できませんでした。");
    } finally {
      setPlacesSaving(false);
    }
  };

  const handleMapFile = async (file?: File) => {
    if (!file) return;
    setMapProcessing(true);
    setError("");
    try {
      const compressed = await compressMapImage(file);
      setMapImageUrl(compressed);
      setMapFileName(file.name);
      setMapDirty(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "画像を処理できませんでした。");
    } finally {
      setMapProcessing(false);
    }
  };

  const saveMapImage = async () => {
    setMapSaving(true);
    setError("");
    try {
      if (demoMode) {
        setMapDirty(false);
      } else if (db) {
        await setDoc(doc(db, "config", "map"), {
          imageDataUrl: mapImageUrl,
          fileName: mapFileName,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      setError("校内マップ画像を保存できませんでした。");
    } finally {
      setMapSaving(false);
    }
  };

  const removeMapImage = () => {
    setMapImageUrl("");
    setMapFileName("");
    setMapDirty(true);
  };

  const downloadPlaceQr = async (place: CampusPlace) => {
    setError("");
    try {
      const url = new URL(import.meta.env.BASE_URL, window.location.origin);
      url.searchParams.set("place", place.id);
      const dataUrl = await QRCode.toDataURL(url.toString(), {
        width: 1000,
        margin: 3,
        errorCorrectionLevel: "H",
        color: { dark: "#173f2b", light: "#ffffff" },
      });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `teapo-${place.id}-qr.png`;
      link.click();
    } catch {
      setError("QRコードを作成できませんでした。");
    }
  };

  const switchDemoRole = (role: Role) => {
    const next = demoUsers.find((item) => item.role === role) ?? demoUsers[0];
    setProfile(next);
    setView("home");
    setSharing(false);
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || chatSending) return;
    const request = buildAiLocationRequest(trimmed, activeLocations, places, now);
    setChatMessages((current) => [...current, { from: "user", text: trimmed }]);
    setChatInput("");
    if (request.localAnswer) {
      setChatMessages((current) => [...current, { from: "assistant", text: request.localAnswer || "回答できませんでした。" }]);
      return;
    }

    if (!request.prompt || !request.aliases) return;
    setChatSending(true);
    try {
      if (demoMode || !aiModel) {
        setChatMessages((current) => [...current, { from: "assistant", text: `${demoAnswer(request.aliases!, activeLocations, places)}（デモ回答）` }]);
        return;
      }
      const result = await aiModel.generateContent(request.prompt);
      const answer = restoreTeacherNames(result.response.text(), request.aliases);
      setChatMessages((current) => [...current, { from: "assistant", text: answer || "回答を生成できませんでした。もう一度お試しください。" }]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      const rateLimited = /429|quota|resource.?exhausted/i.test(message);
      setChatMessages((current) => [...current, {
        from: "assistant",
        text: rateLimited
          ? "Gemini APIの無料枠または一時的な利用上限に達しました。少し時間をおいてお試しください。"
          : "AIに接続できませんでした。時間をおいてもう一度お試しください。",
      }]);
    } finally {
      setChatSending(false);
    }
  };

  const activeLocations = locations.filter((location) => !isExpired(location, now));
  const visibleLocations = activeLocations.filter((location) => {
    const keyword = query.toLowerCase();
    return !keyword || location.displayName.toLowerCase().includes(keyword) || placeLabel(location, places).toLowerCase().includes(keyword);
  });
  const selectedQrPlace = requestedPlaceId ? places.find((place) => place.id === requestedPlaceId && place.active) : undefined;

  if (!firebaseConfigured && !demoMode) return <SetupScreen />;
  if (loading) return <div className="loading-page"><span className="loading-pin"><Icon name="pin" size={28}/></span><p>読み込んでいます…</p></div>;
  if (!profile) return <LoginScreen onLogin={handleLogin} busy={authBusy} error={error} />;

  const canShare = profile.role === "teacher" || profile.role === "admin";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="pin" size={24}/></span><span><b>Teachers-position</b><small>ティーポジ</small></span></div>
        <nav className="side-nav" aria-label="メインメニュー">
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Icon name="home"/><span>ホーム</span></button>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat"/><span>AIに聞く</span></button>
          {profile.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Icon name="admin"/><span>管理</span></button>}
        </nav>
        <div className="sidebar-bottom">
          {demoMode && <div className="demo-switch"><span>デモ権限</span><select value={profile.role} onChange={(event) => switchDemoRole(event.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
          <div className="profile-block"><div className="avatar">{avatarInitial(profile.displayName)}</div><div><strong>{profile.displayName}</strong><span>{roleLabels[profile.role]}</span></div></div>
          <button className="logout-button" onClick={() => auth && signOut(auth)} title="ログアウト"><Icon name="logout"/></button>
        </div>
      </aside>

      <main className="main-content">
        <header className="mobile-header"><div className="brand"><span className="brand-mark"><Icon name="pin" size={20}/></span><b>Teachers-position <small>ティーポジ</small></b></div><div className="avatar small">{avatarInitial(profile.displayName)}</div></header>
        {demoMode && <div className="demo-banner"><span>DEMO</span> Firebase未接続のローカルプレビューです。データは保存されません。</div>}
        {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}

        {view === "home" && (
          <div className="page-wrap">
            <section className="page-heading"><div><p className="eyebrow">TODAY'S CAMPUS</p><h1>こんにちは、{profile.displayName.split(" ")[0]}さん</h1><p>先生が選択している校内の場所を確認できます。</p></div><div className="live-pill"><span/> {activeLocations.length}人が共有中</div></section>

            <section className="privacy-strip"><Icon name="shield" size={21}/><div><strong>GPS・端末の位置情報は使用しません</strong><span>教職員が自分で選択して共有した校内の場所だけを表示します。</span></div></section>

            {canShare && (
              <section className="share-panel">
                <div className="share-title"><div className={sharing ? "share-indicator on" : "share-indicator"}><Icon name="pin"/></div><div><h2>自分のいる場所を共有</h2><p>{sharing ? "選択した場所を共有しています。変更もできます。" : "校内の場所を選んで共有します。"}</p></div></div>
                {selectedQrPlace && <div className="qr-arrival-notice"><strong>QRコードから場所を選択しました</strong><span>「{selectedQrPlace.label}」を選択中です。内容を確認して共有ボタンを押してください。</span></div>}
                <div className="share-fields">
                  <label>現在いる場所<span>一覧から選択</span><select value={placeId} onChange={(event) => setPlaceId(event.target.value)}>{places.filter((place) => place.active).map((place) => <option key={place.id} value={place.id}>{place.label}</option>)}</select></label>
                  <label>在席状況<span>生徒への案内</span><select value={availability} onChange={(event) => setAvailability(event.target.value as Availability)}>{Object.entries(availabilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label>対応予定<span>終了時刻</span><input type="datetime-local" value={availabilityUntil} min={toLocalDateTimeInput(new Date())} onChange={(event) => setAvailabilityUntil(event.target.value)} /></label>
                  <label>共有の有効期限<span>自動で終了</span><select value={shareDurationMinutes} onChange={(event) => setShareDurationMinutes(Number(event.target.value))}><option value={30}>30分</option><option value={60}>1時間</option><option value={120}>2時間</option><option value={240}>4時間</option><option value={480}>8時間</option></select></label>
                  <label className="note-field">ひとこと<span>任意</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={80} placeholder="例：16:30まで在室予定" /></label>
                  <div className="share-actions"><button className="button primary share-button" onClick={shareSelectedPlace} disabled={savingPlace}><Icon name="pin" size={18}/>{savingPlace ? "保存中…" : sharing ? "変更を保存" : "この場所を共有"}</button>{sharing && <button className="button stop" onClick={stopSharing}>共有を停止</button>}</div>
                </div>
                <p className="expiry-note">共有は{shareDurationMinutes >= 60 ? `${shareDurationMinutes / 60}時間` : `${shareDurationMinutes}分`}後に自動終了します。終了前に保存し直すと延長されます。</p>
              </section>
            )}

            <div className="dashboard-grid">
              <section className="map-card"><div className="section-title"><div><p className="eyebrow">CAMPUS MAP</p><h2>校内マップ</h2></div><span className="map-count">{visibleLocations.length} locations</span></div><CampusMap locations={visibleLocations} places={places} mapImageUrl={mapImageUrl}/></section>
              <section className="people-card"><div className="section-title"><div><p className="eyebrow">FACULTY</p><h2>先生を探す</h2></div></div><label className="search-box"><Icon name="search" size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・場所で検索" /></label><div className="teacher-list">
                {visibleLocations.map((location) => {
                  const stale = isStale(location, now);
                  const availabilityEnded = Boolean(location.availabilityUntil && location.availabilityUntil.toMillis() <= now);
                  return <article className={`teacher-row${stale ? " stale" : ""}`} key={location.id}><div className="avatar teacher-avatar">{avatarInitial(location.displayName)}<span className={`status-dot ${location.availability}`}/></div><div className="teacher-info"><div><strong>{location.displayName}</strong><span className={`availability ${availabilityEnded ? "ended" : location.availability}`}>{availabilityEnded ? "対応予定終了" : availabilityLabels[location.availability]}</span></div><p><Icon name="pin" size={14}/>{placeLabel(location, places)}</p>{location.availabilityUntil && <small className="availability-until">対応予定：{formatTime(location.availabilityUntil)}まで</small>}{location.note && <small>{location.note}</small>}</div><div className="updated"><span className={stale ? "stale-label" : ""}>{stale ? "要確認" : timestampLabel(location, now)}</span><span>{stale ? `${timestampLabel(location, now)}に更新` : "選択場所"}</span></div></article>;
                })}
                {!visibleLocations.length && <div className="empty-state"><Icon name="pin" size={30}/><p>条件に合う先生が見つかりません</p></div>}
              </div></section>
            </div>
          </div>
        )}

        {view === "chat" && (
          <div className="page-wrap narrow-page"><section className="page-heading"><div><p className="eyebrow">GEMINI ASSISTANT</p><h1>AIに居場所を聞く</h1><p>共有中の最新データをもとに、Geminiが校内の居場所を案内します。</p></div></section><section className="chat-card"><div className="chat-notice active"><span>AI</span><div><strong>{demoMode ? "デモ回答モード" : "Gemini API 接続済み"}</strong><p>教職員名は匿名IDに置き換えてAIへ送信し、回答後に端末内で元の名前へ戻します。</p></div></div><div className="messages" aria-live="polite">{chatMessages.map((message, index) => <div key={index} className={`message ${message.from}`}><span>{message.from === "assistant" ? "AI" : avatarInitial(profile.displayName)}</span><p>{message.text}</p></div>)}{chatSending && <div className="message typing"><span>AI</span><p><i/><i/><i/><b>Geminiが確認中</b></p></div>}</div><div className="suggestions"><span>質問例</span><button onClick={() => setChatInput("田中先生はどこにいますか？")}>田中先生はどこ？</button><button onClick={() => setChatInput("今、対応できる先生を教えて")}>対応できる先生は？</button><button onClick={() => setChatInput("職員室には誰がいますか？")}>職員室にいる先生は？</button></div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="先生の名前や場所を入力…" disabled={chatSending} maxLength={100}/><button aria-label="送信" disabled={chatSending || !chatInput.trim()}><Icon name="send"/></button></form></section></div>
        )}

        {view === "admin" && profile.role === "admin" && (
          <div className="page-wrap">
            <section className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>管理</h1><p>利用者の権限と、教職員が選べる場所を管理します。</p></div></section>
            <section className="admin-card">
              <div className="admin-summary"><div><span>{users.length}</span><small>登録ユーザー</small></div><div><span>{users.filter((user) => user.role === "teacher").length}</span><small>教職員</small></div><div><span>{users.filter((user) => user.role === "admin").length}</span><small>管理者</small></div></div>
              <div className="admin-section-heading"><div><p className="eyebrow">USERS</p><h2>ユーザー管理</h2></div></div>
              <div className="user-table-wrap"><table><thead><tr><th>ユーザー</th><th>メール</th><th>権限</th><th>状態</th></tr></thead><tbody>{users.map((user) => <tr key={user.uid}><td><div className="table-user"><span className="avatar small">{avatarInitial(user.displayName)}</span><strong>{user.displayName}</strong></div></td><td>{user.email}</td><td><select value={user.role} onChange={(event) => updateRole(user.uid, event.target.value as Role)} disabled={user.uid === profile.uid}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><span className="active-label"><i/>有効</span></td></tr>)}</tbody></table></div>
              <p className="admin-note"><Icon name="shield" size={16}/>自分自身の管理者権限は画面から変更できません。</p>
            </section>

            <section className="admin-card place-admin-card">
              <div className="admin-section-heading place-heading"><div><p className="eyebrow">PLACE OPTIONS</p><h2>場所の選択肢</h2><p>名称、利用状態、校内マップ上の表示位置を編集できます。</p></div><button className="button add-place-button" onClick={addPlace}>＋ 場所を追加</button></div>
              <div className="place-editor-labels"><span /><span>場所名</span><span>マップ横位置</span><span>マップ縦位置</span><span>利用</span><span>QR</span><span /></div>
              <div className="place-editor-list">
                {places.map((place, index) => (
                  <div className="place-editor-row" key={place.id}>
                    <span className="place-number">{String(index + 1).padStart(2, "0")}</span>
                    <input className="place-name-input" value={place.label} maxLength={40} onChange={(event) => updatePlace(place.id, { label: event.target.value })} aria-label={`${index + 1}番目の場所名`} />
                    <label className="position-control"><span>横 <b>{place.left}%</b></span><input type="range" min="8" max="92" value={place.left} onChange={(event) => updatePlace(place.id, { left: Number(event.target.value) })}/></label>
                    <label className="position-control"><span>縦 <b>{place.top}%</b></span><input type="range" min="12" max="88" value={place.top} onChange={(event) => updatePlace(place.id, { top: Number(event.target.value) })}/></label>
                    <label className="place-toggle"><input type="checkbox" checked={place.active} onChange={(event) => updatePlace(place.id, { active: event.target.checked })}/><span>{place.active ? "有効" : "停止"}</span></label>
                    <button className="qr-button" onClick={() => downloadPlaceQr(place)} aria-label={`${place.label}のQRコードをダウンロード`}>QR</button>
                    <button className="remove-place" onClick={() => removePlace(place.id)} disabled={places.length === 1} aria-label={`${place.label}を削除`}>×</button>
                  </div>
                ))}
              </div>
              <div className="place-editor-footer"><p><Icon name="shield" size={16}/>無効にした場所は教職員の選択肢から外れます。削除しても過去履歴は作成されません。</p><button className="button primary" onClick={savePlaces} disabled={!placesDirty || placesSaving}>{placesSaving ? "保存中…" : placesDirty ? "変更を保存" : "保存済み"}</button></div>
            </section>

            <section className="admin-card map-admin-card">
              <div className="admin-section-heading map-heading"><div><p className="eyebrow">FLOOR MAP</p><h2>校内マップ画像</h2><p>校内図・フロアマップを画像で登録し、場所マーカーを重ねて表示できます。</p></div></div>
              <div className="map-admin-grid">
                <div className="map-upload-panel">
                  <label className="map-file-button"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleMapFile(event.target.files?.[0])} disabled={mapProcessing}/><span>{mapProcessing ? "画像を処理中…" : "画像を選択"}</span></label>
                  <p>{mapFileName ? `選択中：${mapFileName}` : "PNG・JPEG・WebP／12MB以下。保存時に自動圧縮します。"}</p>
                  <div className="map-admin-actions"><button className="button stop" onClick={removeMapImage} disabled={!mapImageUrl}>画像を外す</button><button className="button primary" onClick={saveMapImage} disabled={!mapDirty || mapSaving || mapProcessing}>{mapSaving ? "保存中…" : mapDirty ? "マップを保存" : "保存済み"}</button></div>
                  <p className="admin-note"><Icon name="shield" size={16}/>画像は学校アカウントでログインした利用者だけが読み込めます。</p>
                </div>
                <div className="map-preview"><CampusMap locations={activeLocations} places={places} mapImageUrl={mapImageUrl}/></div>
              </div>
            </section>
          </div>
        )}
      </main>

      <nav className="bottom-nav" aria-label="モバイルメニュー"><button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Icon name="home"/><span>ホーム</span></button><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat"/><span>AIに聞く</span></button>{profile.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Icon name="admin"/><span>管理</span></button>}</nav>
    </div>
  );
}

export default App;
