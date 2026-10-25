// Cloud sync: Google sign-in + one Firestore document per player (users/{uid}).
// Talks to app.js only through window.arcTracker and the arc-progress-changed event.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const $ = s => document.querySelector(s);
const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('PASTE_');
const clientId = Math.random().toString(36).slice(2);
const userKey = uid => `arc-mission-control-user-${uid}`;
const stampKey = key => `${key}:updated`;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

const tracker = new Promise(resolve => {
  if (window.arcTracker) resolve(window.arcTracker);
  else addEventListener('arc-tracker-ready', () => resolve(window.arcTracker), { once: true });
});

let loadFailed = false, fb = null, user = null, unsubscribe = null, pushTimer = null, lastApplied = 0;

function setStatus(text) { const el = $('#cloud-status'); if (el) el.textContent = text; }
function setSaveLabel(text) { const el = $('#save-label'); if (el) el.textContent = text; }

function renderAccount() {
  const label = $('#account-label'), msg = $('#account-message'), actions = $('#account-actions');
  actions.innerHTML = '';
  if (!configured) {
    label.textContent = 'Guest · local saves';
    msg.textContent = 'Cloud sync is not configured yet. Progress is saved on this browser.';
    return;
  }
  if (loadFailed) {
    label.textContent = 'Guest · local saves';
    msg.textContent = 'Cloud sync could not connect. Progress is saved on this browser; reload to try again.';
    return;
  }
  const button = document.createElement('button');
  button.className = 'button';
  if (user) {
    label.textContent = user.displayName || user.email || 'Signed in';
    msg.textContent = `Signed in as ${user.email || user.displayName}. Progress syncs to your account on every device.`;
    button.textContent = 'Sign out';
    button.onclick = signOutUser;
  } else {
    label.textContent = 'Sign in to sync';
    msg.textContent = 'You are playing as a guest. Progress is saved on this browser. Sign in to sync it across devices — your guest progress is carried into a new account.';
    button.textContent = 'Sign in with Google';
    button.onclick = signIn;
  }
  actions.append(button);
}

async function loadFirebase() {
  const [{ initializeApp }, auth, firestore] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js')
  ]);
  const app = initializeApp(firebaseConfig);
  return { auth: auth.getAuth(app), authApi: auth, db: firestore.getFirestore(app), fs: firestore };
}

async function signIn() {
  const { auth, authApi } = fb;
  const provider = new authApi.GoogleAuthProvider();
  try { await authApi.signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await authApi.signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      setStatus(`Sign-in failed: ${e.message}`);
    }
  }
}

async function signOutUser() {
  await flush();
  await fb.authApi.signOut(fb.auth);
}

const FRESH = () => ({ completed: [], objectives: {}, materials: {}, raids: [], inventoryVersion: 3, questDeductions: {} });
function valid(t, state) { try { return state ? t.validate(state) : null; } catch { return null; } }
function isFresh(t, state) {
  const v = valid(t, state);
  return !v || JSON.stringify(t.validate(FRESH())) === JSON.stringify(v);
}

function parse(json) { try { return json ? JSON.parse(json) : null; } catch { return null; } }

async function push(t) {
  if (!user) return;
  const key = userKey(user.uid), now = Date.now();
  const { fs, db } = fb;
  try {
    await fs.setDoc(fs.doc(db, 'users', user.uid), {
      stateJson: JSON.stringify(t.read()),
      clientUpdatedAt: now,
      clientId,
      updatedAt: fs.serverTimestamp()
    });
    lastApplied = now;
    store.set(stampKey(key) + ':synced', String(now));
    setSaveLabel('Synced to your account');
    setStatus(`Last synced ${new Date(now).toLocaleTimeString()}.`);
  } catch (e) {
    setSaveLabel('Saved on this browser · sync pending');
    setStatus(`Sync failed: ${e.message}. Changes are kept on this browser and retried on the next change.`);
  }
}

let pendingTracker = null;
function schedulePush(t) { pendingTracker = t; clearTimeout(pushTimer); pushTimer = setTimeout(() => { pushTimer = null; push(t); }, 800); }
async function flush() { if (pushTimer && pendingTracker) { clearTimeout(pushTimer); pushTimer = null; await push(pendingTracker); } }

async function attach(t, u) {
  const key = userKey(u.uid), { fs, db } = fb;
  t.loading(true);
  try {
    const ref = fs.doc(db, 'users', u.uid);
    const snap = await fs.getDoc(ref);
    const cloud = snap.exists() ? snap.data() : null;
    const cloudState = cloud && valid(t, parse(cloud.stateJson));
    const local = valid(t, parse(store.get(key)));
    const localStamp = +store.get(stampKey(key)) || 0;
    const syncedStamp = +store.get(stampKey(key) + ':synced') || 0;
    const guest = valid(t, parse(store.get(t.guestKey)));

    let state, needsPush = false;
    if (cloudState && !(local && localStamp > syncedStamp && localStamp > (cloud.clientUpdatedAt || 0))) {
      state = cloudState; lastApplied = cloud.clientUpdatedAt || 0;
    } else if (cloudState) {
      state = local; needsPush = true; // edits made on this device while offline are newer
    } else {
      state = local || (guest && !isFresh(t, guest) ? guest : t.read());
      needsPush = true;
    }
    t.replace(state, key);
    if (needsPush) await push(t); else { setSaveLabel('Synced to your account'); setStatus('Progress loaded from your account.'); }

    unsubscribe = fs.onSnapshot(ref, s => {
      if (s.metadata.hasPendingWrites || !s.exists()) return;
      const d = s.data();
      if (d.clientId === clientId || (d.clientUpdatedAt || 0) <= lastApplied) return;
      const next = valid(t, parse(d.stateJson));
      if (!next) return;
      lastApplied = d.clientUpdatedAt;
      store.set(stampKey(key) + ':synced', String(d.clientUpdatedAt));
      t.replace(next, key);
      t.announce('Progress updated from another device.');
    });
  } catch (e) {
    setStatus(`Could not load your account progress: ${e.message}`);
    t.announce('Could not reach cloud sync. Using progress saved on this browser.');
  } finally {
    t.loading(false);
  }
}

function detach(t) {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  t.replace(valid(t, parse(store.get(t.guestKey))) || FRESH(), t.guestKey);
  setSaveLabel('Saved on this browser');
  setStatus('');
}

async function main() {
  $('#account-button').onclick = () => $('#account-dialog').showModal();
  $('#account-close').onclick = () => $('#account-dialog').close();
  renderAccount();
  if (!configured) return;

  const t = await tracker;
  addEventListener('arc-progress-changed', e => {
    const key = e.detail?.storageKey;
    store.set(stampKey(key), String(Date.now()));
    if (user && key === userKey(user.uid)) schedulePush(t);
  });
  addEventListener('pagehide', () => { if (pushTimer) push(t); });

  try { fb = await loadFirebase(); }
  catch (e) { loadFailed = true; renderAccount(); return; }

  fb.authApi.getRedirectResult(fb.auth).catch(e => setStatus(`Sign-in failed: ${e.message}`));
  fb.authApi.onAuthStateChanged(fb.auth, async u => {
    const was = user;
    if (was && unsubscribe) { await flush(); }
    user = u;
    renderAccount();
    if (u) await attach(t, u);
    else if (was) detach(t);
  });
}

main();
