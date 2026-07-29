export function StatusMessage({
  error,
  success,
}: {
  error?: string | null;
  success?: string | null;
}) {
  if (error) return <p className="status error" role="alert">{error}</p>;
  if (success) return <p className="status success" role="status">{success}</p>;
  return null;
}

