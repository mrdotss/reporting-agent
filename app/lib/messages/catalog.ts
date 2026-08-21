import type { Language } from "@/lib/messages/language"

/**
 * The message catalog: every fixed string a document or an interface presents, in
 * both declared languages (Requirements 15.2, 15.5, 15.10).
 *
 * ## Why this file exists at all, given the agent has the same map
 *
 * `agent/src/reporting_agent/messages/catalog.v1.json` is the other half. The app
 * does **not** import it: reaching across the monorepo path would tie the web
 * build to the agent's directory layout, and the agent's file ships inside a
 * container image the app never has on disk. So the map is declared twice and a
 * mirror guard asserts the two agree — the same mechanism the event vocabulary
 * and the block-type set already use, rather than a third one invented here.
 *
 * ## Which half resolves which prefix
 *
 * `doc.` and `chart.` ids are resolved by the **agent**, when it compiles a
 * document. `ui.` ids are resolved **here**, when the app presents a stored run.
 * Both halves nevertheless declare **every** id, because the two id sets have to
 * be equal for the guard to be able to compare them at all — and because the app
 * has to present an archived run's fixed copy in that run's pinned language,
 * which means it needs the same declaration the agent rendered from.
 *
 * ## No fallback, here either
 *
 * {@link messageText} returns `undefined` for an id with no value in the
 * requested language rather than substituting the other language's. An English
 * string in an Indonesian interface is indistinguishable from a deliberate
 * choice once a consultant is looking at it, which is the whole of criterion
 * 15.5. The agent's half raises `RENDER_FAILED` for the same reason; the app
 * cannot fail a page render over a label, so it surfaces the absence instead.
 */

// --- BEGIN MESSAGE CATALOG (mirrored in agent/src/reporting_agent/messages/catalog.v1.json) ---
export const MESSAGE_CATALOG = {
  "chart.axis.resource": {
    en: "Resource",
    id: "Sumber daya",
  },
  "chart.axis.time": {
    en: "Time",
    id: "Waktu",
  },
  "chart.axis.value": {
    en: "Value",
    id: "Nilai",
  },
  "chart.label.no_data": {
    en: "No data",
    id: "Tidak ada data",
  },
  "chart.legend.other": {
    en: "Other",
    id: "Lainnya",
  },
  "chart.title.distribution_of": {
    en: "Distribution of",
    id: "Distribusi",
  },
  "chart.title.over_time": {
    en: "over time",
    id: "sepanjang waktu",
  },
  "doc.basis.capacity": {
    en: "capacity",
    id: "kapasitas",
  },
  "doc.basis.highest_observed": {
    en: "highest observed",
    id: "tertinggi teramati",
  },
  "doc.basis.lowest_observed": {
    en: "lowest observed",
    id: "terendah teramati",
  },
  "doc.basis.observed": {
    en: "observed",
    id: "teramati",
  },
  "doc.fidelity.baseline": {
    en: "baseline",
    id: "dasar",
  },
  "doc.fidelity.baseline_meaning": {
    en: "Platform metrics only, with no agent installed in the guest. Averages, minima and maxima are exact. Percentiles are estimated and labelled as such wherever they appear, and per-volume disk free space and guest-observed memory are not available.",
    id: "Hanya metrik platform, tanpa agen yang terpasang di dalam guest. Rata-rata, minimum dan maksimum bersifat eksak. Persentil merupakan estimasi dan diberi label demikian di setiap kemunculannya, serta ruang disk bebas per volume dan memori yang teramati dari dalam guest tidak tersedia.",
  },
  "doc.fidelity.enhanced": {
    en: "enhanced",
    id: "diperluas",
  },
  "doc.fidelity.enhanced_meaning": {
    en: "The customer opted into the Azure Monitor Agent and a Data Collection Rule, so percentiles are computed from the individual samples the guest shipped, and per-volume disk free space and guest-observed memory are available.",
    id: "Pelanggan memilih memasang Azure Monitor Agent beserta Data Collection Rule, sehingga persentil dihitung dari masing-masing sampel yang dikirim guest, dan ruang disk bebas per volume serta memori yang teramati dari dalam guest tersedia.",
  },
  "doc.fidelity.tier_unknown": {
    en: "a tier this report does not describe; treat its figures with the caveats its collection method implies.",
    id: "tingkat yang tidak dijelaskan laporan ini; perlakukan angkanya dengan peringatan yang tersirat dari metode pengumpulannya.",
  },
  "doc.front_matter.catalog_version": {
    en: "Catalog version",
    id: "Versi katalog",
  },
  "doc.front_matter.document_control": {
    en: "Document control",
    id: "Kendali dokumen",
  },
  "doc.front_matter.generated_at": {
    en: "Generated at",
    id: "Dibuat pada",
  },
  "doc.front_matter.prepared_by": {
    en: "Prepared by",
    id: "Disiapkan oleh",
  },
  "doc.front_matter.prepared_for": {
    en: "Prepared for",
    id: "Disiapkan untuk",
  },
  "doc.front_matter.reporting_period": {
    en: "Reporting period",
    id: "Periode pelaporan",
  },
  "doc.front_matter.run_id": {
    en: "Run id",
    id: "ID proses",
  },
  "doc.front_matter.subscription": {
    en: "Subscription",
    id: "Langganan",
  },
  "doc.front_matter.template_version": {
    en: "Template version",
    id: "Versi templat",
  },
  "doc.front_matter.timezone": {
    en: "Timezone",
    id: "Zona waktu",
  },
  "doc.front_matter.toc_heading": {
    en: "Contents",
    id: "Isi",
  },
  "doc.gap.archive_write_failed": {
    en: "A raw response could not be archived, so this run cannot be replayed in full.",
    id: "Sebuah respons mentah gagal diarsipkan, sehingga proses ini tidak dapat diputar ulang secara utuh.",
  },
  "doc.gap.backup_not_configured": {
    en: "No backup is configured for this resource, so there is no last-backup status and no restore point to report.",
    id: "Tidak ada pencadangan yang dikonfigurasi untuk sumber daya ini, sehingga tidak ada status pencadangan terakhir maupun titik pemulihan yang dapat dilaporkan.",
  },
  "doc.gap.catalog_entry_invalid": {
    en: "A catalog entry failed validation and was skipped; no statistic was emitted for it.",
    id: "Sebuah entri katalog gagal validasi dan dilewati; tidak ada statistik yang dihasilkan untuknya.",
  },
  "doc.gap.deallocated": {
    en: "The virtual machine was deallocated, so it emitted no metric for this period. A stopped machine is expected to report nothing.",
    id: "Mesin virtual dalam keadaan deallocated, sehingga tidak mengirim metrik untuk periode ini. Mesin yang dimatikan memang tidak melaporkan apa pun.",
  },
  "doc.gap.definitions_unavailable": {
    en: "The metric definitions for this resource type and region could not be read.",
    id: "Definisi metrik untuk tipe sumber daya dan wilayah ini tidak dapat dibaca.",
  },
  "doc.gap.duplicate_inventory_row": {
    en: "The inventory returned this resource more than once; the first row was used.",
    id: "Inventaris mengembalikan sumber daya ini lebih dari sekali; baris pertama yang digunakan.",
  },
  "doc.gap.fact_unavailable": {
    en: "A request for this fact failed or was rejected, so the fact could not be read. This is distinct from a source that answered and reported nothing configured.",
    id: "Permintaan untuk fakta ini gagal atau ditolak, sehingga fakta tersebut tidak dapat dibaca. Ini berbeda dari sumber yang menjawab dan melaporkan bahwa tidak ada yang dikonfigurasi.",
  },
  "doc.gap.instance_name_collapsed": {
    en: "The guest agent reported one combined instance instead of per-volume rows, so no volume can be named.",
    id: "Agen guest melaporkan satu instans gabungan alih-alih baris per volume, sehingga tidak ada volume yang dapat disebutkan.",
  },
  "doc.gap.interval_counts_missing": {
    en: "An interval omitted the total or the sample count it was asked for, so it was excluded from the average.",
    id: "Sebuah interval tidak menyertakan total atau jumlah sampel yang diminta, sehingga dikecualikan dari rata-rata.",
  },
  "doc.gap.interval_malformed": {
    en: "An interval carried a value that is not a decimal, so it was excluded rather than coerced.",
    id: "Sebuah interval memuat nilai yang bukan desimal, sehingga dikecualikan alih-alih dipaksakan.",
  },
  "doc.gap.metric_error": {
    en: "Azure reported an error for this metric on this resource.",
    id: "Azure melaporkan galat untuk metrik ini pada sumber daya ini.",
  },
  "doc.gap.metric_not_emitted": {
    en: "Azure does not emit this metric for this resource's SKU.",
    id: "Azure tidak mengirimkan metrik ini untuk SKU sumber daya ini.",
  },
  "doc.gap.metric_not_selected": {
    en: "This resource's type was in scope but no metric was requested for it.",
    id: "Tipe sumber daya ini berada dalam cakupan namun tidak ada metrik yang diminta untuknya.",
  },
  "doc.gap.no_reservations": {
    en: "No reservation covers this resource, so there is no term and no expiry to report.",
    id: "Tidak ada reservasi yang mencakup sumber daya ini, sehingga tidak ada jangka waktu maupun tanggal berakhir yang dapat dilaporkan.",
  },
  "doc.gap.no_samples": {
    en: "No sample was folded for this metric on this resource in this period.",
    id: "Tidak ada sampel yang terhimpun untuk metrik ini pada sumber daya ini di periode ini.",
  },
  "doc.gap.percentile_unsupported_unit": {
    en: "This metric's unit family selects no sketch, so its average, minimum and maximum were collected without a percentile.",
    id: "Keluarga satuan metrik ini tidak memilih sketsa apa pun, sehingga rata-rata, minimum dan maksimumnya dikumpulkan tanpa persentil.",
  },
  "doc.gap.permission_denied": {
    en: "Reading this resource was refused, so no value was collected for it.",
    id: "Pembacaan sumber daya ini ditolak, sehingga tidak ada nilai yang dikumpulkan untuknya.",
  },
  "doc.gap.power_state_unknown": {
    en: "The resource's power state could not be read, so its silence cannot be attributed to being stopped.",
    id: "Status daya sumber daya ini tidak dapat dibaca, sehingga ketiadaan datanya tidak dapat dianggap karena mesin dimatikan.",
  },
  "doc.gap.region_unreachable": {
    en: "This location answered through neither the batch endpoint nor the per-resource fallback.",
    id: "Lokasi ini tidak menjawab baik melalui endpoint batch maupun jalur cadangan per sumber daya.",
  },
  "doc.gap.replication_not_enabled": {
    en: "Site Recovery is not enabled for this resource, so there is no replication health to report.",
    id: "Site Recovery tidak diaktifkan untuk sumber daya ini, sehingga tidak ada kesehatan replikasi yang dapat dilaporkan.",
  },
  "doc.gap.resource_absent_from_response": {
    en: "This resource was requested in a batch and was absent from the response.",
    id: "Sumber daya ini diminta dalam satu batch namun tidak ada dalam respons.",
  },
  "doc.gap.response_too_large": {
    en: "A single-resource, single-metric request still answered too large, so no value is recorded for it.",
    id: "Permintaan satu sumber daya dan satu metrik tetap menghasilkan respons terlalu besar, sehingga tidak ada nilai yang dicatat.",
  },
  "doc.gap.sku_capability_missing": {
    en: "The SKU listing carried no value for a capability a derived figure needs.",
    id: "Daftar SKU tidak memuat nilai untuk kemampuan yang dibutuhkan sebuah angka turunan.",
  },
  "doc.gap.sku_unknown": {
    en: "This resource's SKU could not be resolved, so no capacity was available for a derived figure.",
    id: "SKU sumber daya ini tidak dapat ditentukan, sehingga tidak ada kapasitas untuk angka turunan.",
  },
  "doc.methodology.estimated_labelled": {
    en: "Estimated statistics in this report are labelled wherever they appear:",
    id: "Statistik hasil estimasi dalam laporan ini diberi label di setiap kemunculannya:",
  },
  "doc.methodology.heading": {
    en: "How these figures were produced",
    id: "Bagaimana angka-angka ini dihasilkan",
  },
  "doc.notice.empty_scope": {
    en: "No resources matched this scope",
    id: "Tidak ada sumber daya yang cocok dengan cakupan ini",
  },
  "doc.notice.no_data": {
    en: "No values recorded for these resources in this period",
    id: "Tidak ada nilai yang tercatat untuk sumber daya ini pada periode ini",
  },
  "doc.notice.no_gaps": {
    en: "No gaps recorded for this collection",
    id: "Tidak ada celah yang tercatat untuk pengumpulan ini",
  },
  "doc.notice.not_comparable": {
    en: "Not comparable — fidelity tiers differ between runs",
    id: "Tidak dapat dibandingkan — tingkat ketelitian berbeda antar proses",
  },
  "doc.notice.omitted_rows": {
    en: "Not every matched resource is listed above; this table is capped. Resources in the subscription:",
    id: "Tidak semua sumber daya yang cocok tercantum di atas; tabel ini dibatasi. Sumber daya dalam langganan:",
  },
  "doc.provenance.archived_responses": {
    en: "Archived raw responses",
    id: "Respons mentah terarsip",
  },
  "doc.provenance.collection_window": {
    en: "Collection window",
    id: "Jendela pengumpulan",
  },
  "doc.provenance.grain": {
    en: "Grain",
    id: "Granularitas",
  },
  "doc.provenance.raw_archive_complete": {
    en: "Raw archive complete",
    id: "Arsip mentah lengkap",
  },
  "doc.provenance.recorded_gaps": {
    en: "Recorded gaps",
    id: "Celah tercatat",
  },
  "doc.provenance.resources": {
    en: "Resources",
    id: "Sumber daya",
  },
  "doc.provenance.resources_in_scope": {
    en: "Resources in scope",
    id: "Sumber daya dalam cakupan",
  },
  "doc.provenance.snapshot_id": {
    en: "Snapshot id",
    id: "ID snapshot",
  },
  "doc.report.default_title": {
    en: "Infrastructure utilization report",
    id: "Laporan utilisasi infrastruktur",
  },
  "doc.table.basis": {
    en: "Basis",
    id: "Dasar",
  },
  "doc.table.change": {
    en: "Change",
    id: "Perubahan",
  },
  "doc.table.count": {
    en: "Count",
    id: "Jumlah",
  },
  "doc.table.fidelity": {
    en: "Fidelity",
    id: "Ketelitian",
  },
  "doc.table.field": {
    en: "Field",
    id: "Bidang",
  },
  "doc.table.gap": {
    en: "Gap",
    id: "Celah",
  },
  "doc.table.metric": {
    en: "Metric",
    id: "Metrik",
  },
  "doc.table.note": {
    en: "Note",
    id: "Keterangan",
  },
  "doc.table.notice": {
    en: "Notice",
    id: "Catatan",
  },
  "doc.table.period": {
    en: "Period",
    id: "Periode",
  },
  "doc.table.resource": {
    en: "Resource",
    id: "Sumber daya",
  },
  "doc.table.resources_affected": {
    en: "Resources affected",
    id: "Sumber daya terdampak",
  },
  "doc.table.scope": {
    en: "Scope",
    id: "Cakupan",
  },
  "doc.table.this_run": {
    en: "This run",
    id: "Proses ini",
  },
  "doc.table.value": {
    en: "Value",
    id: "Nilai",
  },
  "doc.verification.drift_sample": {
    en: "Drift sample",
    id: "Sampel penyimpangan",
  },
  "doc.verification.figures_checked": {
    en: "Figures checked",
    id: "Angka diperiksa",
  },
  "doc.verification.heading": {
    en: "Verification record",
    id: "Catatan verifikasi",
  },
  "doc.verification.replay_status": {
    en: "Replay",
    id: "Pemutaran ulang",
  },
  "doc.verification.snapshot_digest": {
    en: "Snapshot digest",
    id: "Digest snapshot",
  },
  "doc.verification.status_fail": {
    en: "Not verified",
    id: "Tidak terverifikasi",
  },
  "doc.verification.status_pass": {
    en: "Verified",
    id: "Terverifikasi",
  },
  "ui.download.docx": {
    en: "Download Word",
    id: "Unduh Word",
  },
  "ui.download.pdf": {
    en: "Download PDF",
    id: "Unduh PDF",
  },
  "ui.fidelity.baseline": {
    en: "baseline",
    id: "dasar",
  },
  "ui.fidelity.enhanced": {
    en: "enhanced",
    id: "diperluas",
  },
  "ui.gap_list.collapse": {
    en: "Hide resources",
    id: "Sembunyikan sumber daya",
  },
  "ui.gap_list.empty": {
    en: "No gaps recorded for this run",
    id: "Tidak ada celah tercatat untuk proses ini",
  },
  "ui.gap_list.expand": {
    en: "Show resources",
    id: "Tampilkan sumber daya",
  },
  "ui.gap_list.group_count": {
    en: "affected",
    id: "terdampak",
  },
  "ui.gap_list.heading": {
    en: "Recorded gaps",
    id: "Celah tercatat",
  },
  "ui.provenance.heading": {
    en: "Provenance",
    id: "Asal data",
  },
  "ui.template.untitled_placeholder": {
    en: "Untitled template",
    id: "Templat tanpa nama",
  },
  "ui.verification.failed": {
    en: "Not verified",
    id: "Tidak terverifikasi",
  },
  "ui.verification.figures": {
    en: "figures traced to the snapshot",
    id: "angka terlacak ke snapshot",
  },
  "ui.verification.heading": {
    en: "Verification",
    id: "Verifikasi",
  },
  "ui.verification.not_delivered": {
    en: "This report was not delivered",
    id: "Laporan ini tidak dikirimkan",
  },
  "ui.verification.passed": {
    en: "Verified",
    id: "Terverifikasi",
  },
  "ui.verification.unmatched": {
    en: "Unmatched numerals",
    id: "Angka tidak berpasangan",
  },
} as const satisfies Record<string, Record<Language, string>>
// --- END MESSAGE CATALOG ---

/** Every declared string id. */
export type MessageId = keyof typeof MESSAGE_CATALOG

/**
 * The id namespace, mirroring the agent's `MESSAGE_ID_PATTERN` by value.
 *
 * A closed prefix set, lowercase ASCII, dotted, at least three segments. Closed
 * because the prefix is what says which half resolves an id, so a fourth prefix
 * appearing in one half and not the other is exactly the drift the mirror guard
 * exists to catch.
 */
export const MESSAGE_ID_PATTERN =
  /^(doc|chart|ui)\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Is this a declared string id? */
export function isMessageId(value: unknown): value is MessageId {
  return typeof value === "string" && value in MESSAGE_CATALOG
}

/**
 * The copy for `id` in `language`, or `undefined`.
 *
 * `undefined` rather than the other language's value, and rather than the id
 * itself: a caller decides what to do about an absence, and neither substitute
 * is safe to make silently. Returning the id would print `ui.download.pdf` on a
 * button; returning the English value would put English in an Indonesian
 * interface, which criterion 15.5 forbids.
 */
export function messageText(
  id: MessageId,
  language: Language
): string | undefined {
  return MESSAGE_CATALOG[id]?.[language]
}
