# TODO

## Pending features

### 1. Editable display name + name card upload
**Context:** Some classmates have non-real names on LINE, or want to share their scanned business card.

**Scope (Option B from discussion):**
- [ ] Add editable "顯示名稱" field to intro form
  - Default = LINE `displayName`
  - User can override with preferred / real name
  - Store in existing `classmates.display_name` column
- [ ] Name card upload (business card image)
  - [ ] Create Supabase Storage bucket `namecards` (public read, authenticated write)
  - [ ] Add `namecard_url` column to `classmates` table
  - [ ] Add `<input type="file" accept="image/*">` to intro form
  - [ ] Upload to Supabase Storage on submit
  - [ ] Show thumbnail on `member.html` (login-gated, not on homepage)
  - [ ] Click to enlarge in modal
  - [ ] Warning text: "名片會對登入的同學可見"

**Optional future (Option C):**
- [ ] Gallery view of all name cards
- [ ] OCR extraction (Azure Computer Vision) to auto-fill company/title from name card
