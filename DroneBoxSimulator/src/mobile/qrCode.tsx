export const QrCode = ({ url }: { url: string }) => {
  const encoded = encodeURIComponent(url);
  return (
    <img
      className="qr"
      alt="Mobile viewer QR"
      src={`https://api.qrserver.com/v1/create-qr-code/?size=128x128&data=${encoded}`}
    />
  );
};
