import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

const BASE_URL = 'https://mahoureader.com';
const SERIES_PATH = /^\/series\/\d+\/[^/]+\/?$/;
const CHAPTER_PATH = /^\/series\/\d+\/ler\/\d+\/?$/;

function absoluteUrl(url: string): string {
  try {
    return new URL(url, BASE_URL).toString();
  } catch {
    throw new Error(`MahouReader: URL inválida: ${url}`);
  }
}

function normalizePath(url: string): string {
  const parsed = new URL(url, BASE_URL);
  if (parsed.origin !== BASE_URL) {
    throw new Error('MahouReader: endereço fora do domínio oficial.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function pageOrThrow(html: string, url: string) {
  const $ = loadCheerio(html);
  const title = $('h1').first().text().trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  if (!bodyText || /404|not found|página não encontrada/i.test(title || bodyText.slice(0, 180))) {
    throw new Error(`MahouReader: página inexistente ou vazia (${url}).`);
  }
  return $;
}

function novelItemsFromHtml(html: string): Plugin.NovelItem[] {
  const $ = loadCheerio(html);
  const found = new Map<string, Plugin.NovelItem>();

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) return;

    let url: URL;
    try {
      url = new URL(href, BASE_URL);
    } catch {
      return;
    }

    const path = `${url.pathname}${url.search}`;
    if (!SERIES_PATH.test(url.pathname)) return;

    const anchor = $(element);
    const name =
      anchor.find('h1,h2,h3,h4').first().text().trim() ||
      anchor.attr('title')?.trim() ||
      anchor.text().replace(/\s+/g, ' ').trim();

    if (!name || name.length < 2) return;

    const image = anchor.find('img').first();
    const coverCandidate =
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      image.attr('src') ||
      '';
    const cover = coverCandidate ? absoluteUrl(coverCandidate) : defaultCover;

    if (!found.has(path)) found.set(path, { name, path, cover });
  });

  return [...found.values()];
}

function parseDate(text: string): string {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!match) return '';
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2]}-${match[1]}`;
}

function chapterNumber(name: string, fallback: number): number {
  const match = name.match(/(?:cap[ií]tulo|chapter)\s*([\d]+(?:[.,]\d+)?)/i);
  return match ? Number(match[1].replace(',', '.')) : fallback;
}

class MahouReaderPlugin implements Plugin.PluginBase {
  id = 'mahouReader';
  name = 'MahouReader';
  icon = '';
  site = BASE_URL;
  version = '0.1.0';

  resolveUrl = (path: string) => absoluteUrl(path);

  async popularNovels(
    pageNo: number,
    _options: Plugin.PopularNovelsOptions<undefined>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const url = `${BASE_URL}/`;
    const html = await fetchText(url);
    return novelItemsFromHtml(html);
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1 || !searchTerm.trim()) return [];
    // The live page exposes a search form, but its submit endpoint/query keys
    // are not exposed in the inspected HTML. Avoid guessing them: search the
    // site's publicly listed series links and filter those actual results.
    const html = await fetchText(`${BASE_URL}/series`);
    const term = searchTerm.trim().toLocaleLowerCase();
    return novelItemsFromHtml(html).filter((novel) =>
      novel.name.toLocaleLowerCase().includes(term),
    );
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = normalizePath(novelPath);
    if (!SERIES_PATH.test(new URL(path, BASE_URL).pathname)) {
      throw new Error(`MahouReader: caminho de novel inválido: ${novelPath}`);
    }

    const html = await fetchText(absoluteUrl(path));
    const $ = pageOrThrow(html, absoluteUrl(path));
    const name = $('h1').first().text().trim();
    if (!name) throw new Error('MahouReader: título da novel não encontrado.');

    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const authorMatch = bodyText.match(/Autor\s+(.+?)\s+Formato/i);
    const statusMatch = bodyText.match(/Status\s+(Publicando|Conclu[ií]do|Completo|Hiato)/i);
    const genreHeading = $('h2').filter((_i, el) => /gêneros|generos/i.test($(el).text())).first();
    const genres = genreHeading.length
      ? genreHeading.nextAll('a').map((_i, el) => $(el).text().trim()).get().filter(Boolean).join(', ')
      : '';

    const coverElement = $('img[alt]').filter((_i, el) =>
      ($(el).attr('alt') || '').toLocaleLowerCase().includes(name.toLocaleLowerCase().slice(0, 18)),
    ).first();
    const coverUrl =
      coverElement.attr('data-src') ||
      coverElement.attr('src') ||
      '';

    const synopsisHeading = $('h2').filter((_i, el) => /sinopse/i.test($(el).text())).first();
    const summary = synopsisHeading.length
      ? synopsisHeading.nextUntil('h2').map((_i, el) => $(el).text().trim()).get().filter(Boolean).join('\n\n')
      : '';

    const chapterMap = new Map<string, Plugin.ChapterItem>();
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      let parsed: URL;
      try { parsed = new URL(href, BASE_URL); } catch { return; }
      if (!CHAPTER_PATH.test(parsed.pathname)) return;

      const chapterName = $(el).text().replace(/\s+/g, ' ').trim() || 'Capítulo';
      const chapterPath = `${parsed.pathname}${parsed.search}`;
      chapterMap.set(chapterPath, {
        name: chapterName,
        path: chapterPath,
        releaseTime: parseDate($(el).parent().text()),
        chapterNumber: chapterNumber(chapterName, chapterMap.size + 1),
      });
    });

    // Some pages expose only a "Ler Capítulo 1" call-to-action. Preserve that
    // real link if the complete chapter list is not present in the response.
    const chapters = [...chapterMap.values()];
    if (!chapters.length) {
      const firstChapter = $('a[href]').filter((_i, el) =>
        /ler\s+cap[ií]tulo/i.test($(el).text()),
      ).first().attr('href');
      if (firstChapter) {
        const chapterPath = normalizePath(firstChapter);
        chapters.push({
          name: $('a[href]').filter((_i, el) =>
            /ler\s+cap[ií]tulo/i.test($(el).text()),
          ).first().text().trim() || 'Capítulo 1',
          path: chapterPath,
          chapterNumber: 1,
        });
      }
    }

    const novel: Plugin.SourceNovel = {
      path,
      name,
      author: authorMatch?.[1]?.trim() || '',
      cover: coverUrl ? absoluteUrl(coverUrl) : defaultCover,
      genres,
      status: statusMatch
        ? (/(conclu[ií]do|completo)/i.test(statusMatch[1]) ? NovelStatus.Completed : NovelStatus.Ongoing)
        : NovelStatus.Unknown,
      summary,
      chapters,
    };
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = normalizePath(chapterPath);
    if (!CHAPTER_PATH.test(new URL(path, BASE_URL).pathname)) {
      throw new Error(`MahouReader: caminho de capítulo inválido: ${chapterPath}`);
    }

    const url = absoluteUrl(path);
    const html = await fetchText(url);
    const $ = pageOrThrow(html, url);

    const chapterHeading = $('h1').filter((_i, el) =>
      /cap[ií]tulo/i.test($(el).text()),
    ).first();
    if (!chapterHeading.length) {
      throw new Error('MahouReader: título do capítulo não encontrado.');
    }

    // The inspected chapter page renders the chapter as paragraph blocks
    // after the chapter heading and before the reader controls/comments.
    const paragraphs: string[] = [];
    let started = false;
    $('body').find('h1,h2,h3,p,div').each((_i, el) => {
      const node = $(el);
      if (el === chapterHeading.get(0)) {
        started = true;
        return;
      }
      if (!started) return;

      const text = node.text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (/^(comentários|comentarios|capítulos|capitulos)$/i.test(text)) {
        return;
      }
      if (node.is('p')) {
        const safeHtml = node.html()?.trim();
        if (safeHtml) paragraphs.push(`<p>${safeHtml}</p>`);
      }
    });

    // The first page heading is followed by the novel title; remove it if it
    // was accidentally included as a paragraph by a theme change.
    const content = paragraphs.filter((paragraph) =>
      !paragraph.replace(/<[^>]+>/g, '').trim().toLocaleLowerCase()
        .includes('fui parar dentro de uma história de fantasma'),
    );

    if (!content.length) {
      throw new Error('MahouReader: não foi possível localizar o texto do capítulo.');
    }
    return content.join('\n');
  }
}

export default new MahouReaderPlugin();
