import { AppError } from '@utils/AppError';

export interface PrinterDevice {
  id: string;
  name: string;
  type: 'thermal' | 'inkjet' | 'network';
  connection: 'usb' | 'network' | 'serial';
  isActive: boolean;
}

export abstract class PrinterProvider {
  abstract printInvoice(
    invoiceId: string,
    copies?: number,
  ): Promise<{ sent: boolean; deviceId: string }>;
  abstract printKitchenTicket(
    orderId: string,
    stationId?: string,
  ): Promise<{ sent: boolean; deviceId: string }>;
  abstract testPrint(): Promise<boolean>;
}

export class MockPrinterProvider extends PrinterProvider {
  async printInvoice(invoiceId: string, copies = 1): Promise<{ sent: boolean; deviceId: string }> {
    console.log(`[MockPrinter] Print invoice ${invoiceId} x${copies}`);
    return { sent: false, deviceId: 'simulation-only' };
  }

  async printKitchenTicket(
    orderId: string,
    stationId?: string,
  ): Promise<{ sent: boolean; deviceId: string }> {
    console.log(`[MockPrinter] Kitchen ticket order ${orderId} station ${stationId}`);
    return { sent: false, deviceId: 'simulation-only' };
  }

  async testPrint(): Promise<boolean> {
    console.log('[MockPrinter] Test print OK');
    return false;
  }
}

export async function getPrinterProvider(): Promise<PrinterProvider> {
  if (process.env.NODE_ENV === 'test' && process.env.PRINTER_TYPE === 'mock')
    return new MockPrinterProvider();
  throw new AppError(
    'SERVICE_UNAVAILABLE',
    'A supported printer has not been configured. No print job was sent.',
  );
}
