import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

type LinkEntry = {
  id: number;
  value: string;
};

type GeneratedQr = {
  id: number;
  url: string;
  filename: string;
  dataUrl: string;
};

type WritableFile = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

type DirectoryHandle = {
  getFileHandle(
    name: string,
    options: { create: boolean },
  ): Promise<{ createWritable(): Promise<WritableFile> }>;
};

type PickerWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: "readwrite";
  }) => Promise<DirectoryHandle>;
};

const MAX_LINKS = 10;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const QR_SIZE = 1024;

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.replace(/\.$/, "");
    if (!hostname || hostname.includes("%") || /\s/.test(hostname)) return null;
    if (
      !hostname.includes(":") &&
      hostname.split(".").some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-") ||
          !/^[a-zA-Z0-9-]+$/.test(label),
      )
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    image.src = source;
  });
}

async function createQrImage(url: string, logo: HTMLImageElement | null) {
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: "H",
    margin: 3,
    width: QR_SIZE,
    color: {
      dark: "#172033",
      light: "#FFFFFF",
    },
  });
  const qrImage = await loadImage(qrDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = QR_SIZE;
  canvas.height = QR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("QR 이미지 캔버스를 만들 수 없습니다.");

  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, QR_SIZE, QR_SIZE);
  context.drawImage(qrImage, 0, 0, QR_SIZE, QR_SIZE);

  if (logo) {
    const plateSize = QR_SIZE * 0.26;
    const plateOffset = (QR_SIZE - plateSize) / 2;
    const radius = QR_SIZE * 0.035;
    context.fillStyle = "#FFFFFF";
    context.beginPath();
    context.roundRect(plateOffset, plateOffset, plateSize, plateSize, radius);
    context.fill();

    const imageLimit = QR_SIZE * 0.18;
    const scale = Math.min(imageLimit / logo.width, imageLimit / logo.height);
    const imageWidth = logo.width * scale;
    const imageHeight = logo.height * scale;
    context.drawImage(
      logo,
      (QR_SIZE - imageWidth) / 2,
      (QR_SIZE - imageHeight) / 2,
      imageWidth,
      imageHeight,
    );
  }

  return canvas.toDataURL("image/png");
}

function createFilename(url: string, index: number): string {
  const hostname = new URL(url).hostname
    .replace(/^www\./, "")
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .replace(/\.+/g, "-")
    .slice(0, 40);
  return `qr-${String(index).padStart(2, "0")}-${hostname || "link"}.png`;
}

async function savePng(
  directory: DirectoryHandle,
  filename: string,
  dataUrl: string,
) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
}

function App() {
  const [links, setLinks] = useState<LinkEntry[]>([{ id: 1, value: "" }]);
  const [nextId, setNextId] = useState(2);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState("");
  const [generated, setGenerated] = useState<GeneratedQr[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!logoFile) {
      setLogoUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(logoFile);
    setLogoUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [logoFile]);

  const clearResult = () => {
    setGenerated([]);
    setNotice("");
    setProgress("");
    setFieldErrors({});
  };

  const updateLink = (id: number, value: string) => {
    setLinks((current) =>
      current.map((link) => (link.id === id ? { ...link, value } : link)),
    );
    clearResult();
  };

  const addLink = () => {
    if (links.length >= MAX_LINKS) return;
    setLinks((current) => [...current, { id: nextId, value: "" }]);
    setNextId((current) => current + 1);
    clearResult();
  };

  const removeLink = (id: number) => {
    setLinks((current) => current.filter((link) => link.id !== id));
    clearResult();
  };

  const selectImage = (file: File | undefined) => {
    clearResult();
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice("이미지 파일을 선택해 주세요.");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setNotice("이미지는 10MB 이하의 파일을 선택해 주세요.");
      return;
    }
    setLogoFile(file);
  };

  const generate = async () => {
    const validated = links.map((link) => ({
      ...link,
      url: normalizeUrl(link.value),
    }));
    const errors: Record<number, string> = {};
    for (const link of validated) {
      if (!link.value.trim()) errors[link.id] = "링크를 입력해 주세요.";
      else if (!link.url) errors[link.id] = "올바른 웹 주소를 입력해 주세요.";
    }
    setFieldErrors(errors);
    setNotice("");
    setGenerated([]);
    if (Object.keys(errors).length > 0) return;

    const pickerWindow = window as PickerWindow;
    if (!pickerWindow.showDirectoryPicker) {
      setNotice(
        "폴더 저장은 Chrome 또는 Edge에서 지원됩니다. 해당 브라우저에서 다시 열어 주세요.",
      );
      return;
    }

    let directory: DirectoryHandle;
    try {
      directory = await pickerWindow.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNotice("폴더 선택이 취소되었습니다.");
        return;
      }
      setNotice(`폴더를 열지 못했습니다: ${errorMessage(error)}`);
      return;
    }

    setIsGenerating(true);
    setProgress("");
    try {
      const logo = logoUrl ? await loadImage(logoUrl) : null;
      const completed: GeneratedQr[] = [];
      for (let index = 0; index < validated.length; index += 1) {
        const link = validated[index];
        if (!link.url) continue;
        const dataUrl = await createQrImage(link.url, logo);
        const filename = createFilename(link.url, index + 1);
        await savePng(directory, filename, dataUrl);
        completed.push({ id: link.id, url: link.url, filename, dataUrl });
        setProgress(`${completed.length} / ${validated.length}개 저장 완료`);
      }
      setGenerated(completed);
      setNotice(`${completed.length}개의 QR 코드를 선택한 폴더에 저장했습니다.`);
    } catch (error) {
      setNotice(`저장 중 오류가 발생했습니다: ${errorMessage(error)}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="QR 스튜디오 홈">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>QR 스튜디오</span>
        </a>
        <span className="privacy-note">
          <span className="privacy-dot" />
          이미지는 이 기기에서만 처리돼요
        </span>
      </header>

      <section className="intro">
        <span className="eyebrow">간편한 QR 코드 만들기</span>
        <h1>
          링크를 담고,
          <br />
          나만의 이미지로 완성해요.
        </h1>
        <p>링크를 붙여넣고 이미지를 선택하면 QR 코드가 준비됩니다.</p>
      </section>

      <section className="workspace" aria-label="QR 코드 생성">
        <div className="form-column">
          <section className="panel link-panel">
            <div className="section-heading">
              <div>
                <span className="step-label">STEP 1</span>
                <h2>링크 입력</h2>
              </div>
              <span className="count-badge">{links.length} / {MAX_LINKS}</span>
            </div>
            <div className="link-list">
              {links.map((link, index) => (
                <div className="link-row" key={link.id}>
                  <label className="link-input-wrap">
                    <span className="link-number">{String(index + 1).padStart(2, "0")}</span>
                    <input
                      type="url"
                      inputMode="url"
                      value={link.value}
                      placeholder="https://example.com"
                      aria-label={`${index + 1}번째 링크`}
                      aria-invalid={Boolean(fieldErrors[link.id])}
                      aria-describedby={
                        fieldErrors[link.id] ? `error-${link.id}` : undefined
                      }
                      onChange={(event) => updateLink(link.id, event.target.value)}
                      disabled={isGenerating}
                    />
                    {links.length > 1 && (
                      <button
                        className="remove-link"
                        type="button"
                        aria-label={`${index + 1}번째 링크 삭제`}
                        onClick={() => removeLink(link.id)}
                        disabled={isGenerating}
                      >
                        ×
                      </button>
                    )}
                  </label>
                  {fieldErrors[link.id] && (
                    <span className="field-error" id={`error-${link.id}`}>
                      {fieldErrors[link.id]}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              className="add-link-button"
              type="button"
              onClick={addLink}
              disabled={links.length >= MAX_LINKS || isGenerating}
            >
              <span aria-hidden="true">+</span>
              링크 추가
              <span className="add-hint">최대 {MAX_LINKS}개</span>
            </button>
          </section>

          <section className="panel image-panel">
            <div className="section-heading">
              <div>
                <span className="step-label">STEP 2</span>
                <h2>중앙 이미지</h2>
              </div>
              <span className="optional-badge">선택</span>
            </div>
            <p className="section-description">
              로고나 사진을 넣어 보세요. 흰 배경을 덧대어 QR이 겹치지 않게 해요.
            </p>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="image/*"
              aria-label="중앙에 넣을 이미지 선택"
              onChange={(event) => selectImage(event.target.files?.[0])}
            />
            {logoFile ? (
              <div className="selected-image">
                <span className="image-thumbnail">
                  <img src={logoUrl ?? ""} alt="" />
                </span>
                <span className="selected-image-info">
                  <strong>{logoFile.name}</strong>
                  <span>{(logoFile.size / 1024 / 1024).toFixed(2)} MB · 중앙에 배치</span>
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setLogoFile(null);
                    clearResult();
                  }}
                  disabled={isGenerating}
                >
                  제거
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="upload-area"
                onClick={() => fileInputRef.current?.click()}
                disabled={isGenerating}
              >
                <span className="upload-icon" aria-hidden="true">↑</span>
                <span>
                  <strong>이미지를 선택하세요</strong>
                  <small>PNG, JPG, SVG 등 · 최대 10MB</small>
                </span>
                <span className="browse-button">파일 선택</span>
              </button>
            )}
          </section>

          <div className="action-area">
            <button
              type="button"
              className="generate-button"
              onClick={generate}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <>
                  <span className="spinner" />
                  생성 중...
                </>
              ) : (
                <>
                  <span aria-hidden="true">▦</span>
                  QR 코드 생성 및 폴더에 저장
                </>
              )}
            </button>
            <p>버튼을 누른 뒤 저장할 폴더를 선택해 주세요.</p>
          </div>

          {(notice || progress) && (
            <div
              className={`status-message ${notice.includes("오류") || notice.includes("올바른") ? "status-error" : ""}`}
              role="status"
              aria-live="polite"
            >
              {progress && <span className="status-progress">{progress}</span>}
              {notice}
            </div>
          )}
        </div>

        <aside className="preview-column">
          <div className="preview-heading">
            <div>
              <span className="step-label">미리보기</span>
              <h2>완성된 QR</h2>
            </div>
            <span className="preview-live"><span /> PNG</span>
          </div>
          {generated.length > 0 ? (
            <div className="results-grid">
              {generated.map((item, index) => (
                <article className="result-card" key={item.id}>
                  <img src={item.dataUrl} alt={`${index + 1}번째 링크 QR 코드`} />
                  <strong>{item.filename}</strong>
                  <span>{item.url}</span>
                </article>
              ))}
            </div>
          ) : (
            <>
              <div className="qr-placeholder">
                <div className="placeholder-code" aria-hidden="true">
                  <span className="finder finder-top-left"><i /></span>
                  <span className="finder finder-top-right"><i /></span>
                  <span className="finder finder-bottom-left"><i /></span>
                  <span className="code-dots" />
                  {logoUrl && (
                    <span className="placeholder-logo">
                      <img src={logoUrl} alt="" />
                    </span>
                  )}
                </div>
                <span className="placeholder-caption">
                  {links.some((link) => link.value.trim())
                    ? "생성 버튼을 누르면 QR이 여기에 보여요"
                    : "링크를 입력하면 QR이 여기에 보여요"}
                </span>
              </div>
              <div className="preview-tip">
                <span className="tip-icon" aria-hidden="true">✦</span>
                <p>
                  <strong>더 잘 스캔되도록</strong>
                  중앙 이미지는 자동으로 작게 배치하고, 흰 여백으로 QR 패턴과 분리해요.
                </p>
              </div>
            </>
          )}
          <div className="local-note">
            <span aria-hidden="true">⌑</span>
            QR 생성과 이미지 처리는 브라우저에서 이루어집니다.
          </div>
        </aside>
      </section>
      <footer>QR 스튜디오 <span>·</span> 필요한 만큼, 간단하게</footer>
    </main>
  );
}

export default App;
