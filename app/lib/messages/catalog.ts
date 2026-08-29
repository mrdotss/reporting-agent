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
  "doc.chart.empty": {
    en: "This chart carries no plotted values",
    id: "Bagan ini tidak memuat nilai yang diplot",
  },
  "doc.chart.other_series": {
    en: "Other ({count} series)",
    id: "Lainnya ({count} seri)",
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
    en: "Report profile version",
    id: "Versi profil laporan",
  },
  "doc.front_matter.timezone": {
    en: "Timezone",
    id: "Zona waktu",
  },
  "doc.front_matter.toc_heading": {
    en: "Contents",
    id: "Isi",
  },
  "doc.front_matter.document_name": {
    en: "Document name",
    id: "Nama dokumen",
  },
  "doc.front_matter.document_number": {
    en: "Document number",
    id: "Nomor dokumen",
  },
  "doc.front_matter.confidentiality": {
    en: "Confidentiality notice",
    id: "Pemberitahuan kerahasiaan",
  },
  "doc.front_matter.distribution": {
    en: "Distribution",
    id: "Distribusi",
  },
  "doc.front_matter.distribution_recipient": {
    en: "Recipient",
    id: "Penerima",
  },
  "doc.front_matter.distribution_company": {
    en: "Company",
    id: "Perusahaan",
  },
  "doc.front_matter.distribution_note": {
    en: "Note",
    id: "Catatan",
  },
  "doc.front_matter.revision_history": {
    en: "Revision history",
    id: "Riwayat revisi",
  },
  "doc.front_matter.approver_role": {
    en: "Role",
    id: "Peran",
  },
  "doc.front_matter.approver_company": {
    en: "Company",
    id: "Perusahaan",
  },
  "doc.front_matter.approver_name": {
    en: "Name",
    id: "Nama",
  },
  "doc.front_matter.approver_signature": {
    en: "Signature",
    id: "Tanda tangan",
  },
  "doc.front_matter.role.author": {
    en: "Author",
    id: "Penulis",
  },
  "doc.front_matter.role.reviewer": {
    en: "Quality Control",
    id: "Kontrol Kualitas",
  },
  "doc.front_matter.role.approver": {
    en: "Reviewed By",
    id: "Diperiksa Oleh",
  },
  "doc.front_matter.role.recipient": {
    en: "Customer",
    id: "Pelanggan",
  },
  "doc.gap.advisor_not_available": {
    en: "Azure Advisor has no recommendation on record for this resource.",
    id: "Azure Advisor tidak memiliki rekomendasi tercatat untuk sumber daya ini.",
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
  "doc.preview.notice": {
    en: "Preview — rendered from a stored snapshot. Not a verified deliverable.",
    id: "Pratinjau — dirender dari snapshot tersimpan. Bukan dokumen terverifikasi yang dikirimkan.",
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
  "doc.section.app_service_and_storage": {
    en: "App Service and Storage",
    id: "App Service dan Penyimpanan",
  },
  "doc.section.azure_subscription": {
    en: "Azure Subscription Overview",
    id: "Gambaran Umum Langganan Azure",
  },
  "doc.section.backup_report": {
    en: "Backup Report",
    id: "Laporan Pencadangan",
  },
  "doc.section.coverage_and_verification": {
    en: "Coverage and Verification",
    id: "Cakupan dan Verifikasi",
  },
  "doc.section.database_utilization": {
    en: "Database Utilization",
    id: "Utilisasi Basis Data",
  },
  "doc.section.fleet_summary": {
    en: "Fleet Summary",
    id: "Ringkasan Armada",
  },
  "doc.section.historical_vm_utilization": {
    en: "Historical Utilization Trend",
    id: "Tren Utilisasi Historis",
  },
  "doc.section.incident_report": {
    en: "Incident Report",
    id: "Laporan Insiden",
  },
  "doc.section.network_security_groups": {
    en: "Network Security Groups",
    id: "Grup Keamanan Jaringan",
  },
  "doc.section.public_ip_addresses": {
    en: "Public IP Addresses",
    id: "Alamat IP Publik",
  },
  "doc.section.recommendations": {
    en: "Recommendations",
    id: "Rekomendasi",
  },
  "doc.section.reservations": {
    en: "Reserved Instances",
    id: "Instans Cadangan",
  },
  "doc.section.resource_groups": {
    en: "Resource Groups",
    id: "Grup Sumber Daya",
  },
  "doc.section.virtual_machines": {
    en: "Virtual Machines",
    id: "Mesin Virtual",
  },
  "doc.section.virtual_machines.disks": {
    en: "Disks",
    id: "Disk",
  },
  "doc.section.virtual_machines.inventory": {
    en: "Inventory",
    id: "Inventaris",
  },
  "doc.section.virtual_machines.network": {
    en: "Network Configuration",
    id: "Konfigurasi Jaringan",
  },
  "doc.section.virtual_network": {
    en: "Virtual Networks",
    id: "Jaringan Virtual",
  },
  "doc.section.vm_utilization": {
    en: "Virtual Machine Utilization",
    id: "Utilisasi Mesin Virtual",
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
  "doc.drift.added": {
    en: "{count} resource(s) now match section {section_id} that did not when this profile was last authored: {resource_ids}.",
    id: "{count} sumber daya sekarang cocok dengan bagian {section_id} yang sebelumnya tidak cocok saat profil ini terakhir disusun: {resource_ids}.",
  },
  "doc.drift.removed": {
    en: "{count} resource(s) authored for section {section_id} no longer match: {resource_ids}.",
    id: "{count} sumber daya yang disusun untuk bagian {section_id} tidak lagi cocok: {resource_ids}.",
  },
  "doc.drift.unchanged": {
    en: "Section {section_id} matches exactly the resources authored for it — no drift.",
    id: "Bagian {section_id} cocok persis dengan sumber daya yang disusun untuknya — tidak ada penyimpangan.",
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
  "doc.table.observed_at": {
    en: "All values in this table were observed at {instant}.",
    id: "Semua nilai dalam tabel ini diamati pada {instant}.",
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
    en: "Untitled report profile",
    id: "Profil laporan tanpa nama",
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
  "doc.historical.trend_statement": {
    en: "Historical trend: {count} of {requested} prior periods plotted. {exclusions}",
    id: "Tren historis: {count} dari {requested} periode sebelumnya diplot. {exclusions}",
  },
  "doc.historical.no_prior_runs": {
    en: "No prior verified period is available for this trend.",
    id: "Tidak ada periode terverifikasi sebelumnya yang tersedia untuk tren ini.",
  },
  "doc.historical.verification_note": {
    en: "Each historical point was verified against its own run's verification record. The replay of this run re-verified this run's snapshot alone.",
    id: "Setiap titik historis telah diverifikasi terhadap catatan verifikasi prosesnya sendiri. Pemutaran ulang proses ini hanya memverifikasi ulang snapshot proses ini.",
  },
  "ui.activity.label": {
    en: "Run activity",
    id: "Aktivitas proses",
  },
  "ui.download.heading": {
    en: "Download",
    id: "Unduh",
  },
  "ui.download.description": {
    en: "Every figure in these documents traced to the snapshot named above. Links are minted when you press the button and expire within five minutes.",
    id: "Setiap angka dalam dokumen ini terlacak ke snapshot yang disebutkan di atas. Tautan dibuat saat Anda menekan tombol dan kedaluwarsa dalam lima menit.",
  },
  "ui.download.preparing": {
    en: "Preparing…",
    id: "Menyiapkan…",
  },
  "ui.fidelity.baseline_title": {
    en: "Platform metrics only. Averages, minima and maxima are exact. Percentiles are estimates and are labelled as such wherever they appear. Per-volume disk free space and guest-observed memory are not available at this tier.",
    id: "Hanya metrik platform. Rata-rata, minimum dan maksimum bersifat eksak. Persentil merupakan estimasi dan diberi label demikian di setiap kemunculannya. Ruang disk bebas per volume dan memori yang teramati guest tidak tersedia pada tingkat ini.",
  },
  "ui.fidelity.enhanced_title": {
    en: "Azure Monitor Agent and a Data Collection Rule are in place, so percentiles are true, disk free space is per volume, and memory is guest-observed.",
    id: "Azure Monitor Agent beserta Data Collection Rule telah dipasang, sehingga persentil bersifat benar, ruang disk bebas per volume, dan memori teramati dari guest.",
  },
  "ui.finding.empty_advisory": {
    en: "No advisory findings.",
    id: "Tidak ada temuan saran.",
  },
  "ui.finding.advisory_heading": {
    en: "Advisory findings",
    id: "Temuan saran",
  },
  "ui.finding.advisory_note": {
    en: "Recorded for review. None of these affected the verification status.",
    id: "Dicatat untuk ditinjau. Tidak ada yang memengaruhi status verifikasi.",
  },
  "ui.finding.blocking_heading": {
    en: "Blocking findings",
    id: "Temuan pemblokir",
  },
  "ui.finding.blocking_empty": {
    en: "The verification failed but recorded no blocking finding, which is itself a defect worth reporting.",
    id: "Verifikasi gagal tetapi tidak mencatat temuan pemblokir, yang merupakan cacat yang patut dilaporkan.",
  },
  "ui.provenance.snapshot_path": {
    en: "Snapshot path",
    id: "Jalur snapshot",
  },
  "ui.provenance.unavailable": {
    en: "Provenance unavailable for this figure.",
    id: "Asal data tidak tersedia untuk angka ini.",
  },
  "ui.run_form.subscription_label": {
    en: "Subscription",
    id: "Langganan",
  },
  "ui.run_form.template_label": {
    en: "Report profile",
    id: "Profil laporan",
  },
  "ui.run_form.submit": {
    en: "Request a report",
    id: "Minta laporan",
  },
  "ui.run_form.submitting": {
    en: "Requesting…",
    id: "Meminta…",
  },
  "ui.run_form.no_subscriptions": {
    en: "Connect an Azure subscription before requesting a report. Nothing can be collected until read at subscription scope has been proved.",
    id: "Hubungkan langganan Azure sebelum meminta laporan. Tidak ada yang dapat dikumpulkan hingga pembacaan pada cakupan langganan terbukti.",
  },
  "ui.run_form.duration_hint": {
    en: "A run takes 8 to 12 minutes at a few hundred resources. It is recorded rather than streamed, so closing this tab does not affect it.",
    id: "Sebuah proses membutuhkan 8 hingga 12 menit pada beberapa ratus sumber daya. Hasilnya dicatat bukan dialirkan, jadi menutup tab ini tidak berpengaruh.",
  },
  "ui.run_list.empty_heading": {
    en: "No reports yet",
    id: "Belum ada laporan",
  },
  "ui.run_list.empty_description": {
    en: "A run collects utilization for every resource in scope over a period you choose, then writes one immutable snapshot. It takes 8 to 12 minutes at a few hundred resources, and closing the tab does not affect it.",
    id: "Sebuah proses mengumpulkan utilisasi untuk setiap sumber daya dalam cakupan selama periode yang Anda pilih, lalu menulis satu snapshot yang tidak dapat diubah. Prosesnya membutuhkan 8 hingga 12 menit pada beberapa ratus sumber daya, dan menutup tab tidak berpengaruh.",
  },
  "ui.run_list.period": {
    en: "Period",
    id: "Periode",
  },
  "ui.run_list.resources": {
    en: "Resources",
    id: "Sumber daya",
  },
  "ui.run_list.gaps": {
    en: "Gaps",
    id: "Celah",
  },
  "ui.run_list.started": {
    en: "Started",
    id: "Dimulai",
  },
  "ui.run_list.subscription_removed": {
    en: "Subscription removed",
    id: "Langganan dihapus",
  },
  "ui.run_progress.completed": {
    en: "This run completed.",
    id: "Proses ini selesai.",
  },
  "ui.run_progress.failed": {
    en: "This run failed.",
    id: "Proses ini gagal.",
  },
  "ui.run_progress.duration_hint": {
    en: "This usually takes 8 to 12 minutes.",
    id: "Proses ini biasanya membutuhkan 8 hingga 12 menit.",
  },
  "ui.run_progress.reconnecting": {
    en: "Reconnecting the live view. The run continues either way — its state is recorded, not streamed.",
    id: "Menghubungkan kembali tampilan langsung. Proses tetap berjalan — statusnya dicatat, bukan dialirkan.",
  },
  "ui.run_progress.collection_gaps": {
    en: "Collection gaps",
    id: "Celah pengumpulan",
  },
  "ui.snapshot.no_snapshot": {
    en: "This run produced no snapshot, so there is nothing to trace its figures to.",
    id: "Proses ini tidak menghasilkan snapshot, sehingga tidak ada yang dapat ditelusuri angkanya.",
  },
  "ui.snapshot.label_snapshot": {
    en: "Snapshot",
    id: "Cuplikan",
  },
  "ui.snapshot.label_grain": {
    en: "Grain",
    id: "Granularitas",
  },
  "ui.snapshot.label_window": {
    en: "Window",
    id: "Jendela",
  },
  "ui.snapshot.label_timezone": {
    en: "Timezone",
    id: "Zona waktu",
  },
  "ui.snapshot.label_collected_utc": {
    en: "Collected (UTC)",
    id: "Dikumpulkan (UTC)",
  },
  "ui.snapshot.label_resources": {
    en: "Resources",
    id: "Sumber daya",
  },
  "ui.snapshot.label_gaps_recorded": {
    en: "Gaps recorded",
    id: "Celah tercatat",
  },
  "ui.snapshot.label_fidelity": {
    en: "Fidelity",
    id: "Ketelitian",
  },
  "ui.snapshot.copy_snapshot_id": {
    en: "Copy the snapshot id",
    id: "Salin ID snapshot",
  },
  "ui.verification.absent_description": {
    en: "This report carries no completed verification, so nothing here is presented as proven and no document is offered for download. A report is delivered only behind a passing verification.",
    id: "Laporan ini tidak memiliki verifikasi yang selesai, sehingga tidak ada yang disajikan sebagai terbukti dan tidak ada dokumen yang ditawarkan untuk diunduh. Laporan hanya dikirim setelah verifikasi berhasil.",
  },
  "ui.verification.not_delivered_heading": {
    en: "Not delivered",
    id: "Tidak dikirimkan",
  },
  "ui.verification.replay_heading": {
    en: "Deterministic replay",
    id: "Pemutaran ulang deterministik",
  },
  "ui.verification.replay_not_possible": {
    en: "Not possible for this run — the archived responses it would have re-folded are unavailable, so neither a match nor a mismatch is reported.",
    id: "Tidak memungkinkan untuk proses ini — respons terarsip yang akan dihimpun ulang tidak tersedia, sehingga tidak ada kecocokan maupun ketidakcocokan yang dilaporkan.",
  },
  "ui.verification.drift_heading": {
    en: "Sampled drift (advisory)",
    id: "Penyimpangan tersampel (saran)",
  },
  "ui.verification.drift_empty": {
    en: "No drift sample was recorded for this verification.",
    id: "Tidak ada sampel penyimpangan yang dicatat untuk verifikasi ini.",
  },
  "ui.failure.subscription_label": {
    en: "Subscription",
    id: "Langganan",
  },
  "ui.failure.period_label": {
    en: "Period",
    id: "Periode",
  },
  "ui.failure.no_artifact": {
    en: "No report was produced, and there is nothing to download.",
    id: "Tidak ada laporan yang dihasilkan, dan tidak ada yang dapat diunduh.",
  },
  "ui.failure.artifact_produced": {
    en: "An artifact was produced before the failure.",
    id: "Sebuah artefak dihasilkan sebelum kegagalan.",
  },
  "ui.failure.what_to_check": {
    en: "What to check",
    id: "Yang perlu diperiksa",
  },
  "ui.failure.runtime_reported": {
    en: "What the runtime reported",
    id: "Yang dilaporkan runtime",
  },
  "ui.gap_list.pagination": {
    en: "Showing {shownGroups} of {totalGroups} groups ({shownEntries} of {totalEntries} entries).",
    id: "Menampilkan {shownGroups} dari {totalGroups} grup ({shownEntries} dari {totalEntries} entri).",
  },
  "ui.preview.approximation_notice": {
    en: "This approximates {divergences}. The delivered result is the .pdf below. Hover or focus any figure to see where it came from.",
    id: "Ini memperkirakan {divergences}. Hasil yang dikirimkan adalah .pdf di bawah. Arahkan atau fokuskan angka mana pun untuk melihat asalnya.",
  },
  "ui.preview.delivered_notice": {
    en: "The delivered result is the .pdf below. Hover or focus any figure to see where it came from.",
    id: "Hasil yang dikirimkan adalah .pdf di bawah. Arahkan atau fokuskan angka mana pun untuk melihat asalnya.",
  },
  "ui.preview.heading_approximation": {
    en: "Reading view — an approximation of the delivered page",
    id: "Tampilan baca — perkiraan halaman yang dikirimkan",
  },
  "ui.preview.heading_extract": {
    en: "Reading view — a text extract",
    id: "Tampilan baca — ekstrak teks",
  },
  "ui.run_form.no_selectable_hint": {
    en: "None of your subscriptions can start a run yet. Each one needs a proved subscription-scope Reader assignment and a client secret Azure still accepts.",
    id: "Tidak ada langganan Anda yang bisa memulai proses. Masing-masing membutuhkan penugasan Reader lingkup langganan yang telah dibuktikan dan secret klien yang masih diterima Azure.",
  },
  "ui.run_form.no_templates_hint": {
    en: "You have no report profiles. The three starters are created with your account; if none is listed, author one in the wizard.",
    id: "Anda tidak memiliki profil laporan. Tiga profil awal dibuat bersama akun Anda; jika tidak ada yang tercantum, buat satu di wizard.",
  },
  "ui.run_form.no_template_versions_hint": {
    en: "None of your report profiles has a saved version yet. A report profile gets its first version when the wizard's last step completes.",
    id: "Belum ada profil laporan Anda yang memiliki versi tersimpan. Profil laporan mendapat versi pertamanya saat langkah terakhir wizard selesai.",
  },
  "ui.run_form.pinned_version_hint": {
    en: "Pins version {version}",
    id: "Menggunakan versi {version}",
  },
  "ui.run_form.front_matter_heading": {
    en: "Document details",
    id: "Detail dokumen",
  },
  "ui.run_form.front_matter_hint": {
    en: "This report profile renders a cover and a document-control page, so a run needs a revision row. It is printed in the document and is not collected from Azure.",
    id: "Profil laporan ini menghasilkan halaman sampul dan halaman kendali dokumen, sehingga proses memerlukan baris revisi. Baris tersebut dicetak di dokumen dan tidak dikumpulkan dari Azure.",
  },
  "ui.run_form.revision_label": {
    en: "Revision",
    id: "Revisi",
  },
  "ui.run_form.revision_note_label": {
    en: "Revision note",
    id: "Catatan revisi",
  },
  "ui.run_form.revision_author_label": {
    en: "Author",
    id: "Penulis",
  },
  "ui.scan.heading": {
    en: "What is in this subscription",
    id: "Isi langganan ini",
  },
  "ui.scan.resources_label": {
    en: "Resources",
    id: "Sumber daya",
  },
  "ui.scan.types_label": {
    en: "Types",
    id: "Tipe",
  },
  "ui.scan.regions_label": {
    en: "Regions",
    id: "Region",
  },
  "ui.scan.groups_label": {
    en: "Resource groups",
    id: "Grup sumber daya",
  },
  "ui.scan.rescan": {
    en: "Re-scan",
    id: "Pindai ulang",
  },
  "ui.scan.rescan_running": {
    en: "Scanning…",
    id: "Memindai…",
  },
  "ui.scan.rescan_failed": {
    en: "The scan could not be started.",
    id: "Pemindaian tidak dapat dimulai.",
  },
  "ui.scan.rescan_offline": {
    en: "The scan could not be started. Check your connection.",
    id: "Pemindaian tidak dapat dimulai. Periksa koneksi Anda.",
  },
  "ui.scan.continue": {
    en: "Continue",
    id: "Lanjutkan",
  },
  "ui.scan.group_compute": {
    en: "Compute",
    id: "Komputasi",
  },
  "ui.scan.group_networking": {
    en: "Networking",
    id: "Jaringan",
  },
  "ui.scan.group_data": {
    en: "Data",
    id: "Data",
  },
  "ui.scan.group_not_reportable": {
    en: "Not reportable",
    id: "Tidak dapat dilaporkan",
  },
  "ui.scan.greyed_note": {
    en: "Greyed types have no catalogue entry, so no section can use them. They are listed so their absence from the report is visible rather than silent.",
    id: "Tipe yang diredam tidak memiliki entri katalog, sehingga tidak ada bagian yang dapat menggunakannya. Tipe tersebut tetap dicantumkan agar ketidakhadirannya dalam laporan terlihat, bukan tersembunyi.",
  },
  "ui.scan.empty_scope": {
    en: "This subscription returned no resources in scope. Fix that before authoring a profile: a report over an empty scope would pass every check and prove nothing.",
    id: "Langganan ini tidak mengembalikan sumber daya dalam cakupan. Perbaiki hal itu sebelum menyusun profil: laporan atas cakupan kosong akan lolos setiap pemeriksaan dan tidak membuktikan apa pun.",
  },
  "ui.scan.fallback_region": {
    en: "Batch metrics are refused in {region}. Metrics there are collected one resource at a time; the {count} resources in that region may return no samples and would then appear as recorded gaps.",
    id: "Metrik batch ditolak di {region}. Metrik di sana dikumpulkan satu sumber daya sekaligus; {count} sumber daya di region tersebut mungkin tidak mengembalikan sampel dan akan tercatat sebagai celah.",
  },
  "ui.scan.limits_note": {
    en: "A scan is a point-in-time observation. Every run re-resolves each section's rule against its own snapshot, so a section's estimate here is an estimate.",
    id: "Pemindaian adalah pengamatan pada satu titik waktu. Setiap proses menyelesaikan ulang aturan setiap bagian terhadap snapshot-nya sendiri, sehingga estimasi bagian di sini hanyalah estimasi.",
  },
  "ui.run_form.front_matter_incomplete": {
    en: "Fill in the revision, note and author before requesting this report.",
    id: "Isi revisi, catatan, dan penulis sebelum meminta laporan ini.",
  },
  "ui.run_form.period_explanation": {
    en: 'The collection window comes from the report profile\'s own period rule and resolves when the run is enqueued, in {timezone}. A period is local: "July 2026" means July in that zone, not July in UTC.',
    id: 'Jendela pengumpulan berasal dari aturan periode profil laporan dan diselesaikan saat proses diantrekan, dalam {timezone}. Periode bersifat lokal: "Juli 2026" berarti Juli di zona tersebut, bukan Juli dalam UTC.',
  },
  "ui.run_list.aria_label": {
    en: "Report runs",
    id: "Proses laporan",
  },
  "ui.run_list.utc_suffix": {
    en: "UTC",
    id: "UTC",
  },
  "ui.snapshot.range_to": {
    en: "to",
    id: "hingga",
  },
  "ui.verification.digest_snapshot": {
    en: "Snapshot",
    id: "Cuplikan",
  },
  "ui.verification.digest_docx": {
    en: "Document (.docx)",
    id: "Dokumen (.docx)",
  },
  "ui.verification.digest_pdf": {
    en: "Document (.pdf)",
    id: "Dokumen (.pdf)",
  },
  "ui.verification.pass_summary": {
    en: "{count} figures · every figure traced to snapshot {digest} · verified",
    id: "{count} angka · setiap angka terlacak ke snapshot {digest} · terverifikasi",
  },
  "ui.verification.fail_summary": {
    en: "{count} blocking {noun}. The report was not delivered — no document is offered for download, because no document could be proven against the snapshot.",
    id: "{count} temuan pemblokir {noun}. Laporan tidak dikirimkan — tidak ada dokumen yang ditawarkan untuk diunduh, karena tidak ada dokumen yang dapat dibuktikan terhadap snapshot.",
  },
  "ui.verification.fail_noun_singular": {
    en: "finding",
    id: "temuan",
  },
  "ui.verification.fail_noun_plural": {
    en: "findings",
    id: "temuan",
  },
  "ui.verification.pass_aria": {
    en: "Verification passed. {count} figures traced to the snapshot.",
    id: "Verifikasi berhasil. {count} angka terlacak ke snapshot.",
  },
  "ui.verification.fail_aria": {
    en: "Verification failed with {count} blocking {noun}. The report was not delivered.",
    id: "Verifikasi gagal dengan {count} temuan pemblokir {noun}. Laporan tidak dikirimkan.",
  },
  "ui.verification.replay_folded": {
    en: "{folded} of {named} archived objects re-folded.",
    id: "{folded} dari {named} objek arsip dihimpun ulang.",
  },
  "ui.verification.replay_recomputed_label": {
    en: "recomputed",
    id: "dihitung ulang",
  },
  "ui.verification.replay_stored_label": {
    en: "· stored",
    id: "· tersimpan",
  },
  "ui.verification.drift_summary": {
    en: "{n} resources re-queried · method {method} · seed",
    id: "{n} sumber daya dikueri ulang · metode {method} · benih",
  },
  "ui.verification.drift_no_seed": {
    en: "No drift sample seed was recorded.",
    id: "Tidak ada benih sampel penyimpangan yang dicatat.",
  },
  "ui.verification.drift_not_requeried": {
    en: "{count} selected resources answered nothing and are recorded as not re-queried rather than as agreeing.",
    id: "{count} sumber daya terpilih tidak menjawab apa pun dan dicatat sebagai tidak dikueri ulang alih-alih sebagai menyetujui.",
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
 *
 * When `params` is supplied, the resolved string is interpolated by replacing
 * `{key}` placeholders with the corresponding values. The placeholder set of the
 * message must exactly equal the parameter set: a message carrying a placeholder
 * no caller supplies, or a caller supplying a parameter the message does not
 * carry, throws a `MessageInterpolationError` naming the id and both sets.
 */
export function messageText(
  id: MessageId,
  language: Language,
  params?: Record<string, string | number>
): string | undefined {
  const value = MESSAGE_CATALOG[id]?.[language]
  if (value === undefined) return undefined
  if (!params) return value
  const messagePlaceholders = extractPlaceholders(value)
  const callerParameters = new Set(Object.keys(params))
  if (!setsEqual(messagePlaceholders, callerParameters)) {
    throw new MessageInterpolationError(
      id,
      messagePlaceholders,
      callerParameters
    )
  }
  return value.replace(/\{([^}]+)\}/g, (_, key: string) => String(params[key]))
}

/**
 * Extract `{name}` placeholder names from a template string.
 */
function extractPlaceholders(template: string): Set<string> {
  const result = new Set<string>()
  const re = /\{([^}]+)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    result.add(match[1])
  }
  return result
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

/**
 * The caller's keyword parameters do not exactly match the message's placeholders.
 *
 * Mirrors the agent's `MessageInterpolationError` — same failure, same data,
 * different language.
 */
export class MessageInterpolationError extends Error {
  readonly stringId: string
  readonly messagePlaceholders: Set<string>
  readonly callerParameters: Set<string>

  constructor(
    stringId: string,
    messagePlaceholders: Set<string>,
    callerParameters: Set<string>
  ) {
    super(
      `interpolation mismatch for '${stringId}': ` +
        `the message carries placeholders [${[...messagePlaceholders].sort().join(", ")}] ` +
        `but the caller supplied parameters [${[...callerParameters].sort().join(", ")}]. ` +
        `The two sets must be exactly equal.`
    )
    this.name = "MessageInterpolationError"
    this.stringId = stringId
    this.messagePlaceholders = messagePlaceholders
    this.callerParameters = callerParameters
  }
}
