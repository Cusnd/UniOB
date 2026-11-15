import { useId, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import type { ExportBundle, ImportBundleResponse } from "../types";
import { api } from "../api/client";

function formatDateForFile(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface BackupRestoreSectionProps {
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
  onRestored: () => Promise<void>;
}

/** Collapsible JSON export and restore controls for offline configuration backups. */
export function BackupRestoreSection({
  onError,
  onNotice,
  onRestored,
}: BackupRestoreSectionProps) {
  const importFileId = useId();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] =
    useState<ImportBundleResponse | null>(null);

  const handleExportBundle = async () => {
    setExporting(true);
    onError(null);
    try {
      const bundle = await api.exportBundle();
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `uniob-backup-${formatDateForFile()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotice("已下载完整配置备份文件");
    } catch (err) {
      onError(err instanceof Error ? err.message : "导出备份失败");
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImporting(true);
    onError(null);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as ExportBundle;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("备份文件格式无效，请选择面板导出的 JSON 文件");
      }
      const res = await api.importBundle(parsed);
      setImportResult(res);
      onNotice(
        `备份恢复成功：已导入 ${res.imported.nodes} 台服务器、${res.imported.channels} 个通知渠道`
      );
      await onRestored();
    } catch (err) {
      onError(err instanceof Error ? err.message : "恢复备份失败");
    } finally {
      setImporting(false);
    }
  };

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer text-sm font-medium text-slate-800 select-none dark:text-slate-100">
        备份与恢复（离线导出或导入配置文件）
      </summary>
      <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          将全部服务器信息、通知渠道、告警规则与本月流量统计保存为 JSON 文件，或从本地备份文件恢复。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleExportBundle()}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            导出完整备份 (.json)
          </button>

          <label
            htmlFor={importFileId}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            从备份文件恢复 (.json)
          </label>
          <input
            id={importFileId}
            type="file"
            accept="application/json,.json"
            disabled={importing}
            onChange={(e) => void handleImportFile(e)}
            className="sr-only"
          />
        </div>

        {importResult && (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            已恢复 {importResult.imported.nodes} 台服务器、
            {importResult.imported.channels} 个通知渠道、
            {importResult.imported.rules} 条告警规则、
            {importResult.imported.traffic_ledgers} 条月度流量统计。
          </p>
        )}
      </div>
    </details>
  );
}
