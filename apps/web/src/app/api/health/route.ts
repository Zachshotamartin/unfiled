export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      service: "unfiled-web",
      status: "ok"
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
