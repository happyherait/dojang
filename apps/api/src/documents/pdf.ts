import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 20;
const MAX_TEXT_LENGTH = 20_000;

export class InvalidPdfError extends Error {}

/**
 * PDF의 모든 텍스트를 추출한다. 흰 글씨처럼 사람 눈에 보이지 않는 글자도 함께 나오므로,
 * 결과는 항상 신뢰할 수 없는 데이터로 다룬다.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new InvalidPdfError('PDF 파일이 아닙니다.');
  }

  try {
    const task = getDocument({ data: bytes, verbosity: 0 });
    try {
      const document = await task.promise;
      const pages: string[] = [];
      for (let number = 1; number <= Math.min(document.numPages, MAX_PAGES); number += 1) {
        const page = await document.getPage(number);
        const { items } = await page.getTextContent();
        pages.push(items.map((item) => ('str' in item ? item.str : '')).join(' '));
      }
      return pages.join('\n').slice(0, MAX_TEXT_LENGTH);
    } finally {
      await task.destroy();
    }
  } catch (error) {
    throw new InvalidPdfError(error instanceof Error ? error.message : 'PDF를 읽지 못했습니다.');
  }
}

/** 문서가 닫는 태그를 흉내 내 데이터 영역을 벗어나지 못하게 한다. */
export const wrapUntrustedDocument = (name: string, text: string): string => {
  const safe = (value: string) => value.replace(/<\/?untrusted_document/gi, '[태그 제거]');
  return `<untrusted_document name="${safe(name).replace(/["<>]/g, '')}">\n${safe(text)}\n</untrusted_document>`;
};
