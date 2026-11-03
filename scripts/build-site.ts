/** docs/qna.md를 원문으로 GitHub Pages용 단일 페이지를 만든다. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const REPO = 'https://github.com/happyherait/dojang';
const OUTPUT = '.site';

const source = readFileSync('docs/qna.md', 'utf8');
const start = source.indexOf('\n## ');
if (start < 0) throw new Error('docs/qna.md에서 본문을 찾지 못했습니다.');

const markdown = source
  .slice(start)
  .replace(/\]\(adr\//g, `](${REPO}/blob/main/docs/adr/`)
  .replace(/\]\(\.\.\/README\.md\)/g, `](${REPO}#readme)`);

const toc: string[] = [];
let sections = 0;
const body = (marked.parse(markdown, { async: false }) as string).replace(
  /<h2>(.*?)<\/h2>/g,
  (_match, title: string) => {
    sections += 1;
    toc.push(`<li><a href="#qna-${sections}">${title}</a></li>`);
    return `<h2 id="qna-${sections}">${title}</h2>`;
  },
);

const html = readFileSync('site/template.html', 'utf8')
  .replace('/*STYLES*/', () => readFileSync('site/styles.css', 'utf8'))
  .replace('<!--TOC-->', () => toc.join('\n            '))
  .replace('<!--QNA-->', () => body);

mkdirSync(OUTPUT, { recursive: true });
writeFileSync(`${OUTPUT}/index.html`, html);
console.log(`${OUTPUT}/index.html을 만들었습니다.`);
