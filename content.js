(() => {
  'use strict';

  // ---- Ayarlar ----
  const SPONSOR_HOST = /(^|\.)turkinform\.com(\.tr)?$/i;   // değiştirilecek linkin alan adı
  const SPONSOR_AUTHORS = ['timurun fillerinin bakicisi']; // bilinen sponsor hesap(lar)
  const KEYWORD = 'timursavar';
  const CONCURRENCY = 4;     // aynı anda kaç sayfa çekilecek
  const CACHE_TTL = 15 * 60 * 1000; // 15 dk

  const norm = (s) => (s || '').toLocaleLowerCase('tr');
  const hostOf = (href) => { try { return new URL(href, location.origin).hostname; } catch { return ''; } };
  const isSponsorUrl = (href) => SPONSOR_HOST.test(hostOf(href));
  const isInternal = (href) => /(^|\.)(eksisozluk\.com|ekstat\.com)$/i.test(hostOf(href));

  function getEntries(root) {
    let list = root.querySelectorAll('#entry-item-list > li');
    if (!list.length) list = root.querySelectorAll('li[data-id]');
    return [...list];
  }

  const contentOf = (li) => li.querySelector('.content') || li;

  function authorOf(li) {
    return norm(li.getAttribute('data-author') ||
      li.querySelector('.entry-author')?.textContent || '').trim();
  }

  function sponsorBadges(li) {
    return [...li.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && norm(el.textContent.trim()) === 'sponsorlu'
    );
  }

  const hasSponsorBadge = (li) => sponsorBadges(li).length > 0;

  function authorLinks(li) {
    const links = [...li.querySelectorAll('a.entry-author')];
    if (links.length) return links;
    // yedek: profil linkleri (avatar resmi olanları hariç)
    return [...li.querySelectorAll('a[href*="/biri/"]')].filter((a) => !a.querySelector('img'));
  }

  function isSponsoredEntry(li) {
    return hasSponsorBadge(li) || SPONSOR_AUTHORS.includes(authorOf(li));
  }

  function sponsorLinks(li) {
    return [...contentOf(li).querySelectorAll('a[href]')].filter((a) => isSponsorUrl(a.href));
  }

  function externalLinks(li) {
    return [...contentOf(li).querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => /^https?:\/\//i.test(h) && !isInternal(h) && !isSponsorUrl(h));
  }

  // Bir dokümanda "timursavar" geçen ve dış link içeren ilk entry'yi bul
  function findTimursavar(doc) {
    for (const li of getEntries(doc)) {
      if (isSponsoredEntry(li)) continue;
      if (!norm(contentOf(li).textContent).includes(KEYWORD)) continue;
      const links = externalLinks(li);
      if (links.length) {
        return { url: links[0], entryId: li.getAttribute('data-id'), author: authorOf(li) };
      }
    }
    return null;
  }

  // Bir adresten "başlık-adı--id" yolunu ayıklar; uymuyorsa null döner
  function parseTopicPath(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const m = url.pathname.match(/--(\d+)\/?$/);
      if (!m) return null;
      const path = url.pathname.replace(/\/$/, '');
      return { base: location.origin + path, id: m[1] };
    } catch {
      return null;
    }
  }

  function topicInfo() {
    // 1) canonical etiketi (her sayfada olmayabilir)
    const canon = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
    let info = parseTopicPath(canon);
    if (info) return info;

    // 2) sayfadaki başlık elemanı: data-slug/data-id ya da içindeki link
    const title = document.querySelector('#title, h1[data-id]');
    if (title) {
      const { slug, id } = title.dataset;
      if (slug && id) return { base: `${location.origin}/${slug}--${id}`, id };
      info = parseTopicPath(title.querySelector('a[href]')?.getAttribute('href'));
      if (info) return info;
    }

    // 3) son çare: o anki sayfa adresi
    return parseTopicPath(location.href);
  }

  const pageCountOf = (doc) =>
    parseInt(doc.querySelector('.pager')?.getAttribute('data-pagecount') || '1', 10) || 1;

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(res.status + ' ' + url);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // Başlığın tüm sayfalarını (kronolojik) tarar, en eski timursavar linkini döndürür
  async function scanTopic(base) {
    const first = await fetchDoc(`${base}?p=1`);
    let hit = findTimursavar(first);
    if (hit) return hit;

    const total = pageCountOf(first);
    for (let start = 2; start <= total; start += CONCURRENCY) {
      const pages = [];
      for (let p = start; p < start + CONCURRENCY && p <= total; p++) pages.push(p);
      const docs = await Promise.all(pages.map((p) => fetchDoc(`${base}?p=${p}`).catch(() => null)));
      for (const d of docs) {
        if (d && (hit = findTimursavar(d))) return hit;
      }
    }
    return null;
  }

  async function cacheGet(key) {
    try {
      const v = (await chrome.storage.local.get(key))[key];
      return v && Date.now() - v.ts < CACHE_TTL ? v : null;
    } catch { return null; }
  }

  async function cacheSet(key, hit) {
    try { await chrome.storage.local.set({ [key]: { ...hit, ts: Date.now() } }); } catch {}
  }

  const RED = '#e53935';
  const GREEN = '#81c14b'; // ekşi yeşili
  const GRAY = '#9e9e9e';
  const STATES = {
    loading: { color: GRAY,  msg: 'timur savılmaya çalışılıyor...' },
    fail:    { color: RED,   msg: 'ne yazık ki timur henüz savılmamış...' },
    ok:      { color: GREEN, msg: 'timur başarıyla savılmış oyna devam' },
  };

  // Entry'yi çerçeve, mesaj ve yazar/sponsorlu stilleriyle işaretler
  function markEntry(li, state) {
    const { color, msg } = STATES[state];

    li.style.border = `2px dashed ${color}`;
    li.style.borderRadius = '6px';
    li.style.padding = '8px';

    let note = li.querySelector(':scope > .timursavar-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'timursavar-note';
      note.style.cssText = 'font-weight:bold;margin-bottom:6px;';
      li.prepend(note);
    }
    note.textContent = msg;
    note.style.color = color;

    if (!li.dataset.timursavarEntry) {
      li.dataset.timursavarEntry = '1';
      for (const a of authorLinks(li)) {
        a.style.setProperty('color', RED, 'important');
        a.style.setProperty('text-decoration', 'line-through', 'important');
      }
      for (const el of sponsorBadges(li)) {
        el.style.setProperty('color', RED, 'important');
        el.style.setProperty('text-decoration', 'line-through', 'important');
      }
    }
  }

  function replaceLinks(li, hit) {
    for (const a of sponsorLinks(li)) {
      if (a.dataset.timursavar) continue;
      a.dataset.timursavar = '1';
      a.dataset.originalHref = a.href;
      a.href = hit.url;
      a.title = hit.url;
      a.style.outline = `1px dashed ${GREEN}`;

      const badge = document.createElement('a');
      badge.textContent = ' ↪ timursavar';
      badge.href = hit.entryId ? `/entry/${hit.entryId}` : '#';
      badge.title = `kaynak: ${hit.author || '?'} | orijinal: ${a.dataset.originalHref}`;
      badge.style.cssText = `font-size:0.8em;color:${GREEN};margin-left:4px;text-decoration:none;`;
      a.after(badge);
    }
  }

  async function main() {
    const targets = getEntries(document).filter((li) => isSponsoredEntry(li) && sponsorLinks(li).length);
    if (!targets.length) return;

    const topic = topicInfo();
    if (!topic) return;

    const key = `ts:${topic.id}`;
    let hit = findTimursavar(document) || (await cacheGet(key));
    if (!hit) {
      targets.forEach((li) => markEntry(li, 'loading'));
      try { hit = await scanTopic(topic.base); } catch (e) { console.warn('[timursavar]', e); }
    }

    if (hit) {
      cacheSet(key, hit);
      targets.forEach((li) => { replaceLinks(li, hit); markEntry(li, 'ok'); });
    } else {
      targets.forEach((li) => markEntry(li, 'fail'));
    }
  }

  main();
})();
