import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { config } from '@config/index';

export interface RenderContext {
  url: string;
  label: string;
  restaurantName?: string;
  restaurantLogo?: string;
  brandColor?: string;
  headerText?: string;
}

export async function renderPng(ctx: RenderContext): Promise<Buffer> {
  return QRCode.toBuffer(ctx.url, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 600,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

export async function renderSvg(ctx: RenderContext): Promise<string> {
  return QRCode.toString(ctx.url, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 600,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

export async function renderPdf(ctx: RenderContext): Promise<Buffer> {
  const png = await renderPng(ctx);
  const doc = new PDFDocument({ size: 'A5', margin: 30 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk as Buffer));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const brandColor = ctx.brandColor || '#E8447A';

  // Header bar with brand color
  doc.rect(0, 0, doc.page.width, 50).fill(brandColor);

  // Logo if provided
  if (ctx.restaurantLogo) {
    try {
      const logoBuffer = Buffer.from(ctx.restaurantLogo.split(',')[1] || ctx.restaurantLogo, 'base64');
      doc.image(logoBuffer, 15, 8, { height: 34 });
    } catch {
      // Logo failed, continue without it
    }
  }

  // Restaurant name in header
  if (ctx.restaurantName) {
    const nameX = ctx.restaurantLogo ? 60 : 15;
    doc.fontSize(14).fillColor('#FFFFFF').text(ctx.restaurantName, nameX, 15, {
      width: doc.page.width - nameX - 15,
      align: 'left',
    });
  }

  doc.y = 60;
  doc.moveDown(0.3);

  // Header text if provided
  if (ctx.headerText) {
    doc.fontSize(10).fillColor('#666').text(ctx.headerText, { align: 'center' });
    doc.moveDown(0.3);
  }

  // Table number or label in large bold
  doc.fontSize(40).fillColor('#1a1a1a').text(ctx.label, { align: 'center' });
  doc.moveDown(0.4);

  // QR code
  const imageY = doc.y;
  const imageSize = 220;
  const imageX = doc.page.width / 2 - imageSize / 2;
  doc.image(png, imageX, imageY, { width: imageSize, height: imageSize });
  doc.y = imageY + imageSize + 12;

  // Call-to-action
  doc.fontSize(12).fillColor(brandColor).text('Scan to Order', { align: 'center' });
  doc.moveDown(0.2);

  // Footer
  doc
    .fontSize(8)
    .fillColor('#999')
    .text(`Made with SmartDine · ${new Date().toLocaleDateString()}`, { align: 'center' });

  doc.end();

  await finished;
  return Buffer.concat(chunks);
}
