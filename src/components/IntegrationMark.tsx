/** A connected tool's own logo. Where each comes from: public/integrations/SOURCES.md. */
export function IntegrationMark({ id, size = 18 }: { id: string; size?: number }) {
  return (
    <img
      src={`./integrations/${id}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
