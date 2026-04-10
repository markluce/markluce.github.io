# Debug path — browser cache vs deployed file

## Symptom
User reports `https://markluce.ai/schedule.html` shows old content after a push:
- W1 09:00-10:20 row still shows `蔡明順 & GIGA` / `AIA 校務長 / Nautilus AI`
- Row count shows `34 / 66` even though the "顯示休息 / 午餐 / 影片" checkbox appears checked (should be 66)

But the git commit `2ddbef9` already updated these values.

## Investigation steps

### Step 1 — Is the commit actually pushed?
```bash
git log --oneline -5
# 2ddbef9 fix: schedule.html W1 09:00-10:20 — cleaner 校務長 title + org
git status
# clean, up to date with origin/main
```
✅ Pushed.

### Step 2 — Is GitHub Pages actually serving the new version?
Fetch the file directly (bypassing browser):
```bash
curl -s "https://markluce.ai/schedule.html" > /tmp/sched_live.html
grep -n "始業式・校務長演講" /tmp/sched_live.html
```
Result:
```
204: { ..., teacher:'蔡明順 校務長 & GIGA', org:'台灣人工智慧學校 / Nautilus AI 執行長' },
```
✅ **Deployed file has new values.** The CDN is serving the updated file.

### Step 3 — Is filter logic broken?
```bash
grep -n "showBreaks" /tmp/sched_live.html
```
Result:
```
364: var showBreaks = document.getElementById('f-breaks').checked;
369: if (!showBreaks && (r.period === '休息' || r.period === '影片')) return false;
```
✅ Filter logic is correct. Checkbox `checked` by default.

### Step 4 — Conclusion
Since the server returns the new version but the user's browser shows the old one, **the browser is using a cached copy**.

## Why does this happen?

GitHub Pages serves HTML with a default `Cache-Control: max-age=600` (10 min). After a push:
- CDN edge nodes update within ~30-60 seconds (fast)
- User's browser keeps its local cached copy for up to 10 minutes
- Hard refresh bypasses this local cache

The problem is made worse because there's no versioned query string on the HTML file itself (e.g. `/schedule.html?v=20260410`).

## Fixes / mitigations

### Immediate (user)
- **Hard refresh**: `Ctrl+Shift+R` / `Cmd+Shift+R`
- **DevTools → Disable cache** while debugging
- **Incognito window** (no cache)

### Permanent (code)
Options to avoid future surprise:

1. **Add a cache-busting comment** in commits that people test — user will see a different number
2. **Add `<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">`** in the HTML head
   - Pro: Forces fresh fetch every time
   - Con: Slower load, more bandwidth
3. **Use query-string versioning**: change links to `/schedule.html?v=20260410`
   - Requires updating every reference to the file
4. **Service worker** that auto-updates — overkill for this site

## Recommendation
For a prototype site with a small user base, the simplest is **option 2** for critical pages (admin, schedule) where freshness matters more than bandwidth.

## How to check "is my deploy actually live?" in 10 seconds
```bash
curl -s https://markluce.ai/schedule.html | grep "SOMETHING_UNIQUE_TO_THIS_VERSION"
```
If grep returns a match, the CDN has the new file. Any discrepancy with browser display = client-side cache.
