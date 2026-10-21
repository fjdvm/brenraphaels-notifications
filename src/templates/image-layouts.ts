import { esc } from './escape';

/** Width of the white card's content area, in px. */
const CONTENT_WIDTH = 552;
const GAP = 8;
const SPACER = `font-size:0;line-height:0`;

/**
 * A layout is a list of bands (rows); a band is a list of columns, left to right; a column is a list
 * of tile heights, top to bottom. Images fill the tiles band by band, column by column, so an image's
 * place in the list is its place in the reading order. A height of 0 keeps the image's own proportions.
 */
type Layout = number[][][];

const LAYOUTS = {
  single: [[[0]]],
  'two-columns': [[[272], [272]]],
  'two-rows': [[[276]], [[276]]],
  'three-feature-left': [[[360], [176, 176]]],
  'three-feature-top': [[[300]], [[180], [180]]],
  'three-row': [[[178], [178], [178]]],
  'four-grid': [
    [[200], [200]],
    [[200], [200]],
  ],
  'four-feature-left': [[[376], [120, 120, 120]]],
  'four-feature-top': [[[300]], [[140], [140], [140]]],
} satisfies Record<string, Layout>;

/** `stacked` is every image full width, one above the other, whatever their number. */
export const IMAGE_LAYOUTS = ['stacked', ...Object.keys(LAYOUTS)] as [
  'stacked',
  ...(keyof typeof LAYOUTS)[],
];

export type ImageLayout = (typeof IMAGE_LAYOUTS)[number];

const tileCount = (layout: Layout) => layout.flat(2).length;

const tile = (src: string, width: number, height: number) =>
  `<img src="${esc(src)}" alt="" width="${width}"${height ? ` height="${height}"` : ''} style="display:block;width:100%;max-width:100%;height:${height ? `${height}px` : 'auto'};${height ? 'object-fit:cover;' : ''}border:0;border-radius:8px">`;

const stacked = (images: string[]) =>
  images
    .map(
      (src) =>
        `<tr><td style="padding:0 0 16px">${tile(src, CONTENT_WIDTH, 0)}</td></tr>`,
    )
    .join('');

/** The rows of the table that holds a Marketing Email's images, laid out as chosen. */
export function renderImages(
  images: string[],
  layout: ImageLayout = 'stacked',
): string {
  const bands = layout === 'stacked' ? undefined : LAYOUTS[layout];
  // A layout that does not fit the images is not worth failing a send over.
  if (!bands || tileCount(bands) !== images.length) return stacked(images);

  const queue = [...images];

  return bands
    .map((columns, i) => {
      const width = Math.floor(
        (CONTENT_WIDTH - GAP * (columns.length - 1)) / columns.length,
      );
      const cells = columns
        .map((heights) => {
          const rows = heights.map(
            (height) =>
              `<tr><td>${tile(queue.shift()!, width, height)}</td></tr>`,
          );
          const gap = `<tr><td height="${GAP}" style="height:${GAP}px;${SPACER}">&nbsp;</td></tr>`;
          return `<td valign="top" style="vertical-align:top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join(gap)}</table></td>`;
        })
        .join(
          `<td width="${GAP}" style="width:${GAP}px;${SPACER}">&nbsp;</td>`,
        );
      const below = i === bands.length - 1 ? 16 : GAP;
      return `<tr><td style="padding:0 0 ${below}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>${cells}</tr></table></td></tr>`;
    })
    .join('');
}
