"""Bounded physical source planning and text-layer PDF decoding."""
from __future__ import annotations

import base64
import binascii
import io
import re

from nobei_core.constants import MAX_DOCUMENT_BYTES
from nobei_core.errors import CoreProblem

MAX_PDF_BYTES = 5 * 1024 * 1024


def extraction_plan(text: str) -> dict:
    blocks = []
    start = 0
    while start < len(text):
        end = min(start + 4000, len(text))
        if end < len(text):
            # Prefer paragraph/header boundaries without producing tiny physical blocks.
            matches = list(re.finditer(r'\n\n|\n(?=#)', text[start:end]))
            if matches and matches[-1].end() >= 2000:
                end = start + matches[-1].end()
        blocks.append({'id': f'b{len(blocks) + 1}', 'textStart': start, 'textEnd': end})
        start = end
    strategy = 'L1' if len(text) <= 6000 else 'L2' if len(text) <= 24000 else 'L3'
    containers = []
    boundaries = []
    index = 0
    while index < len(blocks):
        selected = blocks[index:index + 6] if strategy == 'L3' else blocks
        containers.append({'blockIds': [b['id'] for b in selected],
                           'textStart': selected[0]['textStart'], 'textEnd': selected[-1]['textEnd']})
        if strategy != 'L3' or index + 6 >= len(blocks):
            break
        boundaries.append({'textStart': blocks[index + 4]['textStart'],
                           'textEnd': blocks[index + 6]['textEnd']})
        index += 5
    calls = 1 if strategy == 'L1' else len(containers) + sum(len(c['blockIds']) for c in containers) + len(boundaries)
    return {'strategy': strategy, 'blocks': blocks, 'containers': containers,
            'boundaries': boundaries, 'maxCalls': calls}


def pdf_text(content_base64: object) -> tuple[str, list[dict]]:
    if not isinstance(content_base64, str):
        raise CoreProblem('INVALID_PARAMS', 'PDF contentBase64 must be a string')
    if len(content_base64) > ((MAX_PDF_BYTES + 2) // 3) * 4:
        raise CoreProblem('REQUEST_TOO_LARGE', 'PDF exceeds 5 MiB limit')
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CoreProblem('PDF_MALFORMED', 'PDF base64 is invalid') from exc
    if len(data) > MAX_PDF_BYTES:
        raise CoreProblem('REQUEST_TOO_LARGE', 'PDF exceeds 5 MiB limit')
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise CoreProblem('PDF_ENCRYPTED', 'Encrypted PDF is unsupported')
        parts, pages, offset, total_bytes = [], [], 0, 0
        for number, page in enumerate(reader.pages, 1):
            part = (page.extract_text() or '').replace('\r\n', '\n').replace('\r', '\n').strip('\n')
            if number > 1:
                offset += 2
                total_bytes += 2
            total_bytes += len(part.encode('utf-8'))
            if total_bytes > MAX_DOCUMENT_BYTES:
                raise CoreProblem('REQUEST_TOO_LARGE', 'PDF extracted text exceeds 512 KiB')
            pages.append({'page': number, 'textStart': offset, 'textEnd': offset + len(part)})
            parts.append(part)
            offset += len(part)
        text = '\n\n'.join(parts)
        if not text.strip():
            raise CoreProblem('PDF_NO_TEXT', 'PDF has no text layer; scanned PDF/OCR is unsupported')
        return text, pages
    except CoreProblem:
        raise
    except Exception as exc:
        raise CoreProblem('PDF_MALFORMED', 'PDF is damaged or cannot be parsed') from exc
