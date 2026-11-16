export {};
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const camera = element<HTMLVideoElement>("camera"),
  start = element<HTMLButtonElement>("start"),
  snap = element<HTMLButtonElement>("snap"),
  done = element<HTMLButtonElement>("done"),
  status = element("status");
const sessionId = location.pathname.split("/")[2];
interface Photo {
  id: string;
  blob: Blob;
  url: string;
  sha256: string;
}
const photos: Photo[] = [];
let stream: MediaStream | null = null,
  busy = false,
  locked = false,
  expiresAt = 0,
  expiryTimer: ReturnType<typeof setTimeout>;
function say(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
function failure(error: unknown) {
  say(error instanceof Error ? error.message : String(error), true);
}
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/sessions/${sessionId}${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    const b = (await response.json()) as { error?: string };
    throw new Error(b.error || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<{
    state: string;
    expires_at: number;
    label: string;
    environment: string;
    thread: string;
  }>;
}
function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  camera.srcObject = null;
  camera.hidden = true;
  snap.hidden = true;
  start.hidden = false;
  start.textContent = "Enable camera";
}
function render() {
  const list = element("photos");
  list.replaceChildren();
  photos.forEach((photo, index) => {
    const figure = document.createElement("figure"),
      img = document.createElement("img"),
      remove = document.createElement("button");
    img.src = photo.url;
    img.alt = `Photo ${index + 1}`;
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove photo ${index + 1}`);
    remove.disabled = busy || locked;
    remove.onclick = () => {
      URL.revokeObjectURL(photo.url);
      photos.splice(index, 1);
      render();
    };
    figure.append(img, remove);
    list.append(figure);
  });
  done.disabled = busy || photos.length === 0;
  done.textContent = busy
    ? "Sending…"
    : `Done · send ${photos.length || ""} photo${photos.length === 1 ? "" : "s"}`;
  snap.disabled = busy || photos.length >= 20;
  start.disabled = busy || locked;
}
start.onclick = async () => {
  start.disabled = true;
  try {
    if (Date.now() >= expiresAt * 1000)
      throw new Error("Session expired. Ask the agent for a new /pic link.");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 2560 },
        height: { ideal: 1920 },
      },
    });
    camera.srcObject = stream;
    camera.hidden = false;
    await camera.play();
    start.hidden = true;
    snap.hidden = false;
    say("Take as many photos as you need, then tap Done.");
  } catch (error) {
    stop();
    failure(error);
  } finally {
    start.disabled = false;
  }
};
snap.onclick = async () => {
  snap.disabled = true;
  try {
    if (!camera.videoWidth || !camera.videoHeight)
      throw new Error("Wait for the camera preview, then try again.");
    const scale = Math.min(
        1,
        2000 / Math.max(camera.videoWidth, camera.videoHeight),
      ),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(camera.videoWidth * scale);
    canvas.height = Math.round(camera.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Photo capture is unavailable.");
    ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("JPEG conversion failed."))),
        "image/jpeg",
        0.88,
      ),
    );
    const sha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    photos.push({
      id: crypto.randomUUID(),
      blob,
      url: URL.createObjectURL(blob),
      sha256,
    });
    render();
    say(
      `${photos.length} photo${photos.length === 1 ? "" : "s"} ready. You can remove any before sending.`,
    );
  } catch (error) {
    failure(error);
  } finally {
    snap.disabled = busy || photos.length >= 20;
  }
};
done.onclick = async () => {
  busy = true;
  locked = true;
  stop();
  render();
  try {
    const state = await api("");
    if (state.state === "open") {
      for (const [index, p] of photos.entries()) {
        say(`Sending photo ${index + 1} of ${photos.length}…`);
        await api(`/photos/${p.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "image/jpeg",
            "X-Content-SHA256": p.sha256,
          },
          body: p.blob,
        });
      }
      await api("/done", { method: "POST" });
    }
    clearTimeout(expiryTimer);
    element("capture").hidden = true;
    element("success").hidden = false;
    say("Delivered to the waiting session.");
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    photos.length = 0;
  } catch (error) {
    failure(error);
    busy = false;
    render();
  }
};
window.addEventListener("pagehide", stop);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});
async function init() {
  if (!sessionId) {
    element("chat").textContent = "Your next look starts in chat";
    element("capture").hidden = true;
    say(
      "Type /pic in the chat that should receive your photos, then open its link.",
    );
    return;
  }
  try {
    const s = await api("");
    expiresAt = s.expires_at;
    element("chat").textContent = s.label;
    element("details").textContent = `${s.environment} · ${s.thread}`;
    if (s.state !== "open") {
      element("capture").hidden = true;
      element("success").hidden = false;
      say("These photos have already been sent.");
      return;
    }
    start.disabled = false;
    say(
      "Enable the camera when you’re ready. This link accepts photos for 30 minutes.",
    );
    expiryTimer = setTimeout(
      () => {
        stop();
        start.disabled = true;
        done.disabled = true;
        say("Session expired. Ask the agent for a new /pic link.", true);
      },
      Math.max(0, expiresAt * 1000 - Date.now()),
    );
  } catch (error) {
    element("chat").textContent = "Capture unavailable";
    element("capture").hidden = true;
    failure(error);
  }
}
void init();
