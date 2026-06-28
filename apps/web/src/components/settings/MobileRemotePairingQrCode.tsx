import QRCode from "react-qr-code";

interface MobileRemotePairingQrCodeProps {
  value: string;
}

export function MobileRemotePairingQrCode({ value }: MobileRemotePairingQrCodeProps) {
  return (
    <div
      aria-label="Pairing QR code"
      className="inline-flex rounded-xl border border-border bg-white p-3"
      role="img"
    >
      <QRCode
        bgColor="#ffffff"
        fgColor="#000000"
        level="M"
        size={168}
        title="Mobile pairing QR code"
        value={value}
      />
    </div>
  );
}
