/**
 * Kaswin Offline Protocol Workbench - Interactive Controller
 *
 * Implements offline parameter exploration, real-time BigInt prize preview,
 * draft JSON export/import, strict security boundaries, and UNVERIFIED LOCAL DATA tagging.
 *
 * Notice:
 * - DOM untrusted strings are assigned strictly via .textContent (never innerHTML).
 * - No fetch, no WebSockets, no wallet APIs, no secret key handling.
 * - Money action buttons are explicitly disabled.
 */

import {
  parseKasToSompi,
  formatSompiToKas,
  formatSompiDisplay,
  validateTicketCount,
  validateRefundDaa,
  validateTitle,
  calculateGrossPool,
  validateDraftPayload,
  createDraftExportObject,
  validateAndParseDraftJson,
  TICKET_COUNT_MIN,
  TICKET_COUNT_MAX,
  MAX_INT64
} from "./validation.js";

// DOM Elements
const formEl = document.getElementById("draft-form");
const titleInput = document.getElementById("draft-title");
const priceInput = document.getElementById("ticket-price-kas");
const countInput = document.getElementById("ticket-count");
const refundDaaInput = document.getElementById("refund-daa");

const validationAlert = document.getElementById("validation-alert");
const validationErrorMsg = document.getElementById("validation-error-msg");

const previewGrossKas = document.getElementById("preview-gross-kas");
const previewGrossSompi = document.getElementById("preview-gross-sompi");
const previewSingleSompi = document.getElementById("preview-single-sompi");
const previewSingleKas = document.getElementById("preview-single-kas");
const previewCountDisplay = document.getElementById("preview-count-display");

const draftStatusBadge = document.getElementById("draft-status-badge");
const jsonInspector = document.getElementById("json-inspector");
const copyJsonBtn = document.getElementById("btn-copy-json");
const downloadJsonBtn = document.getElementById("btn-download-json");
const fileInput = document.getElementById("file-input");
const importFileBtn = document.getElementById("btn-import-file");
const parsePastedJsonBtn = document.getElementById("btn-parse-pasted-json");
const resetFormBtn = document.getElementById("btn-reset-form");

// Default initial draft values
const INITIAL_DRAFT = {
  title: "Kaswin A 型离线草案 001",
  ticketPriceKas: "10",
  ticketCount: "100",
  refundThresholdDaa: "95000000"
};

/**
 * Updates UI error banner.
 * Uses textContent exclusively to guard against untrusted strings.
 *
 * @param {string|null} errorText
 */
function setValidationError(errorText) {
  if (!errorText) {
    validationAlert.style.display = "none";
    validationErrorMsg.textContent = "";
  } else {
    validationAlert.style.display = "block";
    validationErrorMsg.textContent = errorText;
  }
}

/**
 * Calculates current values and updates prize pool preview.
 * Returns validated payload if valid, null if invalid.
 */
function updatePreview() {
  const rawPayload = {
    title: titleInput.value,
    ticketPriceKas: priceInput.value,
    ticketCount: countInput.value,
    refundThresholdDaa: refundDaaInput.value
  };

  try {
    const validated = validateDraftPayload(rawPayload);
    setValidationError(null);

    // Exact sompi displays
    const grossDisplay = formatSompiDisplay(validated.grossPoolSompi);
    const singleDisplay = formatSompiDisplay(validated.ticketPriceSompi);

    previewGrossKas.textContent = `${grossDisplay.kasFormatted} KAS`;
    previewGrossSompi.textContent = `(${grossDisplay.sompiFormatted} sompis)`;
    previewSingleKas.textContent = `${singleDisplay.kasFormatted} KAS`;
    previewSingleSompi.textContent = `${singleDisplay.sompiFormatted} sompis`;
    previewCountDisplay.textContent = `${validated.ticketCount.toLocaleString()} 张`;

    return validated;
  } catch (err) {
    setValidationError(err.message || "输入参数不符合 A 型离线草案规格");
    previewGrossKas.textContent = "— KAS";
    previewGrossSompi.textContent = "(参数校验未通过)";
    previewSingleKas.textContent = "— KAS";
    previewSingleSompi.textContent = "— sompis";
    previewCountDisplay.textContent = "—";
    return null;
  }
}

/**
 * Sets draft status badge and styling.
 *
 * @param {boolean} isUnverified
 */
function setDraftStatus(isUnverified) {
  if (isUnverified) {
    draftStatusBadge.textContent = "⚠️ 未验证的本地数据（绝非链上证据，未部署，不可投注）";
    draftStatusBadge.className = "card-badge unverified";
  } else {
    draftStatusBadge.textContent = "本地设计草案（离线推演）";
    draftStatusBadge.className = "card-badge";
  }
}

/**
 * Populates form inputs and triggers preview update.
 *
 * @param {object} payload
 * @param {boolean} isUnverified
 */
function populateForm(payload, isUnverified = false) {
  titleInput.value = payload.title || "";
  priceInput.value = payload.ticketPriceKas || "";
  countInput.value = String(payload.ticketCount || "");
  refundDaaInput.value = payload.refundThresholdDaa || "";

  setDraftStatus(isUnverified);
  const validated = updatePreview();

  if (validated) {
    const draftExport = createDraftExportObject({
      title: validated.title,
      ticketPriceKas: validated.ticketPriceKas,
      ticketCount: validated.ticketCount,
      refundThresholdDaa: validated.refundThresholdDaa
    });
    jsonInspector.value = JSON.stringify(draftExport, null, 2);
  }
}

/**
 * Handles JSON download as file.
 */
function handleDownloadJson() {
  const validated = updatePreview();
  if (!validated) {
    alert("当前参数校验未通过，无法导出有效草案。请检查红字提示。");
    return;
  }

  const exportObj = createDraftExportObject({
    title: validated.title,
    ticketPriceKas: validated.ticketPriceKas,
    ticketCount: validated.ticketCount,
    refundThresholdDaa: validated.refundThresholdDaa
  });

  const jsonStr = JSON.stringify(exportObj, null, 2);
  jsonInspector.value = jsonStr;

  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `kaswin-a-draft-${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Handles copy JSON to clipboard.
 */
async function handleCopyJson() {
  const jsonStr = jsonInspector.value.trim();
  if (!jsonStr) {
    alert("检查区内暂无草案 JSON 数据。");
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(jsonStr);
      const originalText = copyJsonBtn.textContent;
      copyJsonBtn.textContent = "✓ 已复制到剪贴板";
      setTimeout(() => {
        copyJsonBtn.textContent = originalText;
      }, 2000);
    } else {
      jsonInspector.select();
      document.execCommand("copy");
      alert("草案 JSON 已复制到剪贴板。");
    }
  } catch (err) {
    jsonInspector.select();
    alert("复制失败，请手动在下方文本框中全选复制。");
  }
}

/**
 * Handles importing JSON string (from file or paste).
 *
 * @param {string} rawJson
 */
function handleImportJsonString(rawJson) {
  try {
    const importResult = validateAndParseDraftJson(rawJson);
    populateForm(
      {
        title: importResult.validatedPayload.title,
        ticketPriceKas: importResult.validatedPayload.ticketPriceKas,
        ticketCount: importResult.validatedPayload.ticketCount,
        refundThresholdDaa: importResult.validatedPayload.refundThresholdDaa
      },
      true // Mark as unverified local data
    );
    jsonInspector.value = JSON.stringify(importResult.draft, null, 2);
    setValidationError(null);
  } catch (err) {
    setValidationError(`导入失败: ${err.message}`);
  }
}

/**
 * Wire up UI events
 */
function initEvents() {
  // Real-time input updates
  titleInput.addEventListener("input", updatePreview);
  priceInput.addEventListener("input", updatePreview);
  countInput.addEventListener("input", updatePreview);
  refundDaaInput.addEventListener("input", updatePreview);

  // Prevent form submission
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    handleDownloadJson();
  });

  // Action buttons
  downloadJsonBtn.addEventListener("click", handleDownloadJson);
  copyJsonBtn.addEventListener("click", handleCopyJson);

  // File import
  importFileBtn.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (file.size > 65536) {
      setValidationError(`导入文件过大 (${file.size} 字节)。离线草案文件不得超过 64 KB。`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      handleImportJsonString(evt.target.result);
    };
    reader.onerror = () => {
      setValidationError("文件读取失败。");
    };
    reader.readAsText(file);
  });

  // Paste import from inspector textarea
  parsePastedJsonBtn.addEventListener("click", () => {
    const raw = jsonInspector.value.trim();
    if (!raw) {
      setValidationError("请先在下方文本框中粘贴草案 JSON 内容。");
      return;
    }
    handleImportJsonString(raw);
  });

  // Reset form
  resetFormBtn.addEventListener("click", () => {
    populateForm(INITIAL_DRAFT, false);
  });
}

// Initial bootstrap
function init() {
  initEvents();
  populateForm(INITIAL_DRAFT, false);
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
