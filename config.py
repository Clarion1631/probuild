# ── Configuration ─────────────────────────────────────────────────────────────

TARGET_URL = "https://pro.houzz.com"

SCRAPINGBEE_API_KEY = "BTBLV67V1AQOKJBDT0BVQ6VHJFUHH0VMCZP2A6UQ9YCKJMV5QCV1GJESBDZ5WR7ZAPIDCHWJDMF3GNO0"
GEMINI_API_KEY      = "AIzaSyDvtHgimqZyD8E1yeSNiCtFO-TcDgrWpgU"
ANTHROPIC_API_KEY   = ""

# ── Session cookies (extracted from your browser export) ──────────────────────
# Only name/value pairs are needed — domain/expiry etc. are ignored by ScrapingBee.
# Most important are the auth cookies: _ivy_session_key, _csrf, h0-h3, hzua1/2, v
SESSION_COOKIES = {
    # ── Auth / session (critical) ──────────────────────────────────────────────
    "_ivy_session_key": "TUNtcHM1ZTJRRXFjR2xQQTR6eW1LMlVsZEQvbHFadDJLaWZ4Z201T2s3Y3I1Sk9zRlVWNEowQm1OTEZ4emVWTnd2dXFaZWJtT29icFd3OXF2djRtdk9hRlIyRktRbElwNm8rdGlvQ1lIdUpUb1psL3lpYTJ0ak13dzN4UmxUVXlWdG9mdzBUaXVTc3dEMVcwZUZmalZVekc2MnY2VHFkY0xvUVZwZjg3MmpPZXFaZnJkUTJEZXQ1eFhCZis1WmZnUTB3ZThveURrTy9LcStoNkxxL3lMRGZhc3FZTHFGUm53Wlp4NE5QYjNPVXVJUm0xQXd6eXJveWp5UHhGdzhKSU92UFVJdEZFRGo4dlAxbU1vQkVyZVdheFFLVEJ4QnR6WnlHZzB5VzF3ZEhVZ2FwdE1xMkhzNHZXeldxcGJoakgtLUd1cmwyR3dxWjQ5Nk1SeWVneEY2bHc9PQ%3D%3D--6f89b53feb55935396d4baf6da5690daf95eda6c",
    "_csrf":            "Lda_-ysfSKTo03_HaSOEON8T",
    "h0":               "CwBlALtyq2kMefBJCAMIAAAAw%2FryqKJBhLwrON24J2%2FAs3HPDabybEh1Fbg9b3D1ICVqdXN0aW5fYWRraW5zODQ%3D",
    "h1":               "CwBlALtyq2kMefBJCAMIAAAAanTwrBAh8czuOy4v%2FHoQts4uqB0%2BtSVEVxqtsppY7LNqdXN0aW5fYWRraW5zODQ%3D",
    "h2":               "CwBlALtyq2kMefBJCAMJAAAAyhzUiC3hbDfe7ODosB0PXmESpHTsLOalCX6fh44IHvxqdXN0aW5fYWRraW5zODQ%3D",
    "h3":               "CwBlALtyq2kMefBJCAMJAAAAzJ8Z2vAPiBqusZ%2BDJBQ7Rhvj5%2FZERYHoTlbKRXW5CNdqdXN0aW5fYWRraW5zODQ%3D",
    "hzua1":            "anTwrBAh8czuOy4v%2FHoQts4uqB0%2BtSVEVxqtsppY7LM%3D",
    "hzua2":            "anTwrBAh8czuOy4v%2FHoQts4uqB0%2BtSVEVxqtsppY7LM%3D",
    "v":                "1763675512_9c99d090-04e4-4c9b-ba88-99eb0734c04d_264bffa0c124896ddb59a079cae1276b",
    "hzv":              "1763675512_9c99d090-04e4-4c9b-ba88-99eb0734c04d_264bffa0c124896ddb59a079cae1276b",
    "vct":              "en-US-SBx4jR9pCR94jR9p8B94jR9p4R01mM1p4h01mM1p",
    "cced":             "1",
    "hzd":              "d334d385-0f41-4bc2-845e-7414ef8d9be3%3A%3A%3A%3A%3AProjects",
    "ivydbex":          "1775157660139",
    "documentWidth":    "1920",
    "jdv":              "",
    # ── Analytics / misc (optional but keeps page behaviour consistent) ─────────
    "_fbp":             "fb.1.1763675513007.1036449689",
    "_ga":              "GA1.1.993893870.1763675513",
    "ajs_anonymous_id": "%22333fd96f-92c0-4819-8c2a-35789dfe93d0%22",
    "intercom-device-id-ce1qt1wj": "e7583c64-7b60-4456-8416-f743a085f217",
    "intercom-session-ce1qt1wj":   "QzFLQldNc0htK1k0bjc3anNOQ1QwUGxFL2w0MklMWVhFZkdYeWZKVksxeXF1WDlWa1lHcHBDVDV4ZTZnUm94cGhqQzgwRWxlZnIzNllFLytIa2NGbDZGY0JSQnRVaEdTM0FUUFlmbVJvWDlnR05xemdjSTI2MkpQWG1RQVVXcGExaUJtL3ZQYTM0MzhRK3BZNGtjVUltY1pTOVRrQmNGYUFjUU03U01QZ0RSSUt5RGVSeTUzb2VpdTJzVFNUUll5ZW5LOGZMbjZJaXYrTmFXVUNGMnpISXQ3VjJwS1FOeXd2WVljSEZwemU0QT0tLWo5cko0bSs1OEl6cHY2eDMyZjNyTUE9PQ==--6b3c90e6a2f44cce45f6b015917465944b723989",
    "fs_uid":           "#T6Q2#05b73f79-926a-480d-9ddb-9ea283496a68:c5111f67-8271-441b-b7cc-475f8e6e2d61:1774832833618::1#668a773e#/1795212331",
    "ABTasty":          "uid=ppznp29avd3vtmhc&fst=1763675521070&pst=1763752776720&cst=1763759658404&ns=5&pvt=6&pvis=2&th=",
    "__stripe_mid":     "26ea8163-8117-4257-a493-6ce59f01b15831e734",
}

# ── Explicit URL list ──────────────────────────────────────────────────────────
# pro.houzz.com is a React SPA — we scrape these exact routes rather than crawling.
# Hash fragments (#section) on the same base URL are deduplicated below.
URL_LIST = [
    # Projects
    "https://pro.houzz.com/manage/projects",
    "https://pro.houzz.com/manage/projects/2340349/overview",
    "https://pro.houzz.com/manage/d/projects/2340349/contracts",
    "https://pro.houzz.com/manage/d/contracts/4111290/edit",
    "https://pro.houzz.com/manage/d/projects/2340349/estimates",
    "https://pro.houzz.com/manage/d/estimates/5962494/edit",
    "https://pro.houzz.com/manage/projects/2340349/mood-boards",
    "https://pro.houzz.com/manage/moodboards/216622234",
    "https://pro.houzz.com/manage/projects/2942703/takeoffs",
    "https://pro.houzz.com/manage/tjp/canvas/3fb6ef1349625b175751c68734eb0a9b042b8c10/page/1.0",
    "https://pro.houzz.com/manage/projects/2942703/floor-plans",
    "https://pro.houzz.com/manage/floorplans/214199026",
    "https://pro.houzz.com/manage/selections/projects/2942703/boards",
    "https://pro.houzz.com/manage/selections/board/2350172",
    "https://pro.houzz.com/manage/bids/projects/2942703/bid-packages",
    "https://pro.houzz.com/manage/bids/bid-packages/100584/edit",
    "https://pro.houzz.com/manage/projects/2942703/files",
    "https://pro.houzz.com/manage/schedule/projects/2942703",
    "https://pro.houzz.com/manage/tasks/projects/2942703",
    # Client dashboard
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/messages",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/contracts",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/financials",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/online-payment-records",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/selection-boards",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/mood-boards",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/3d-floor-plans",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/tasks",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/schedule",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/files-and-photos",
    "https://pro.houzz.com/manage/cd/client-dash-edit/2942703/daily-logs",
    # Project financials
    "https://pro.houzz.com/manage/projects/2942703/daily-logs",
    "https://pro.houzz.com/manage/projects/2942703/time-and-expenses",
    "https://pro.houzz.com/manage/d/projects/2942703/request-payments",
    "https://pro.houzz.com/manage/d/request-payments/6244036/edit/",
    "https://pro.houzz.com/manage/d/purchase-documents/6244044/edit/",
    "https://pro.houzz.com/manage/d/projects/2942703/change-orders",
    "https://pro.houzz.com/manage/d/change-orders/6244048/edit/",
    "https://pro.houzz.com/manage/projects/2942703/retainers-and-credits",
    "https://pro.houzz.com/manage/d/retainers/6244052/edit/",
    "https://pro.houzz.com/manage/reports/budget/2942703",
    "https://pro.houzz.com/manage/projects/2942703/financial-overview",
    # Leads
    "https://pro.houzz.com/manage/leads",
    "https://pro.houzz.com/manage/leads/20778907",
    "https://pro.houzz.com/manage/leads/20778907/notes",
    "https://pro.houzz.com/manage/tasks/leads/20778907",
    "https://pro.houzz.com/manage/leads/20778907/floorPlans",
    "https://pro.houzz.com/manage/floorplans/new?iId=20778907",
    "https://pro.houzz.com/manage/schedule/leads/20778907",
    "https://pro.houzz.com/manage/leads/20778907/files",
    "https://pro.houzz.com/manage/leads/20778907/takeoffs",
    "https://pro.houzz.com/manage/tjp/canvas/147167c2b058bbdc6f3c0fef9fee778834120822/page/1.0",
    "https://pro.houzz.com/manage/d/leads/20778907/estimates",
    "https://pro.houzz.com/manage/d/estimates/6244091/edit/",
    "https://pro.houzz.com/manage/d/leads/20778907/contracts",
    "https://pro.houzz.com/manage/d/contracts/6244093/edit",
    # Payments (hash routes map to same base page — only unique bases scraped)
    "https://pro.houzz.com/manage/py/online/setup",
    "https://pro.houzz.com/manage/py/heloc",
    "https://pro.houzz.com/manage/py/financing?source=Self%20Discovery",
    "https://pro.houzz.com/manage/py/intuit",
    # Reports
    "https://pro.houzz.com/manage/reports/",
    "https://pro.houzz.com/manage/reports/PaymentsReport",
    "https://pro.houzz.com/manage/reports/PayoutsReport",
    "https://pro.houzz.com/manage/reports/OpenInvoicesReport",
    "https://pro.houzz.com/manage/reports/TaxesLiabilityReport",
    "https://pro.houzz.com/manage/reports/IncomingTransactionsReport?groupBy=parentId",
    "https://pro.houzz.com/manage/reports/OutgoingTransactionsReport?groupBy=projectId",
    "https://pro.houzz.com/manage/reports/TimeBillingReport?groupBy=houzzUserId",
    "https://pro.houzz.com/manage/reports/TimeBillingReport?groupBy=projectId",
    "https://pro.houzz.com/manage/reports/GlobalTrackerReport",
    # QuickBooks
    "https://pro.houzz.com/manage/build/company/quickbooks/dashboard",
    "https://pro.houzz.com/manage/build/company/quickbooks/settings",
    "https://pro.houzz.com/manage/build/company/quickbooks/account-mappings/general",
    "https://pro.houzz.com/manage/build/company/quickbooks/account-mappings/products",
    "https://pro.houzz.com/manage/build/company/quickbooks/account-mappings/services",
    "https://pro.houzz.com/manage/build/company/quickbooks/vendor-mapping",
    "https://pro.houzz.com/manage/build/company/quickbooks/connection",
    # Settings
    "https://pro.houzz.com/settings/team-members",
    "https://pro.houzz.com/settings/contacts",
    "https://pro.houzz.com/settings/subcontractors",
    "https://pro.houzz.com/settings/vendors",
    "https://pro.houzz.com/settings/company-info",
    "https://pro.houzz.com/settings/communication",
    "https://pro.houzz.com/settings/notifications",
    "https://pro.houzz.com/settings/cloud-storage",
    "https://pro.houzz.com/settings/zapier",
    "https://pro.houzz.com/settings/account-info",
    "https://pro.houzz.com/settings/privacy-security",
    # Templates
    "https://pro.houzz.com/templates",
    "https://pro.houzz.com/manage/projects/project-templates",
    "https://pro.houzz.com/manage/d/contract-templates",
    "https://pro.houzz.com/manage/d/templates",
    "https://pro.houzz.com/manage/floorplans/templates",
    "https://pro.houzz.com/manage/selections/templates/boards",
    "https://pro.houzz.com/manage/moodboards/templates",
    "https://pro.houzz.com/manage/schedule/templates",
    "https://pro.houzz.com/manage/projects/task-templates",
    # Items / catalog
    "https://pro.houzz.com/manage/l/category-management",
    "https://pro.houzz.com/manage/l/my-items",
    "https://pro.houzz.com/manage/catalogs/",
    # Misc
    "https://pro.houzz.com/teamchat/channels/all",
    "https://pro.houzz.com/manage/build/company/addresses",
    "https://pro.houzz.com/manage/build/company/salesTaxes",
    "https://pro.houzz.com/manage/build/company/features",
    "https://pro.houzz.com/manage/projects/workday-exceptions",
    "https://pro.houzz.com/manage/build/clipper-settings",
    "https://pro.houzz.com/manage/build/company/calendarSettings",
]

# ── Scraper settings ───────────────────────────────────────────────────────────

REQUEST_DELAY  = 1.5      # base seconds between pages (scraper adds jitter on top)

# ── Storage settings ───────────────────────────────────────────────────────────

OUTPUT_DIR = "output"
DB_PATH    = f"{OUTPUT_DIR}/pages.db"

# ── AI cloning settings ────────────────────────────────────────────────────────

CLONE_MODEL       = "gemini-3-flash-preview"
MAX_HTML_CHARS    = 20000  # Gemini Flash has a huge context window — use it
CLONE_CONCURRENCY = 3      # Gemini rate limits are generous on Flash
