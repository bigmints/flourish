import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function OfflinePage() {
  return <main className="flex min-h-dvh items-center justify-center px-4 py-10">
    <Card className="w-full max-w-md">
      <CardContent className="p-6 text-center md:p-8">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><ChartNoAxesCombined className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Offline</h1>
        <p className="mt-2 text-sm text-muted-foreground">Reconnect and try again.</p>
        <Button className="mt-6 w-full" asChild><a href="/"><RefreshCw className="h-4 w-4" /> Try again</a></Button>
      </CardContent>
    </Card>
  </main>;
}
