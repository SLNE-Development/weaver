"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weaver/ui/components/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@weaver/ui/components/chart";

/** One day of a usage series. */
interface Point {
  day: string;
  downloads: number;
}

const CONFIG = { downloads: { label: "Downloads", color: "var(--chart-2)" } } satisfies ChartConfig;

/** Short axis label of a `YYYY-MM-DD` day, such as `Oct 21`. */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Downloads per day as one bar series (a single axis, zero-based), with the total in the header. */
export function DownloadsChart({ series, title = "Downloads" }: { series: Point[]; title?: string }) {
  const total = series.reduce((sum, point) => sum + point.downloads, 0);
  return (
    <Card data-testid="downloads-chart">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription>
          {total.toLocaleString("en")} {total === 1 ? "download" : "downloads"} in this period
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No downloads in this period.</p>
        ) : (
          <ChartContainer config={CONFIG} className="h-48 w-full">
            <BarChart data={series} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, items) => shortDay(String(items[0]?.payload?.day ?? ""))} />} />
              <Bar dataKey="downloads" fill="var(--color-downloads)" radius={2} />
            </BarChart>
          </ChartContainer>
        )}
        {total > 0 && (
          <details className="mt-3 text-sm">
            <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">Show data</summary>
            <table className="mt-2 w-full max-w-xs text-left">
              <caption className="sr-only">{title} per day</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Day
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Downloads
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.map((point) => (
                  <tr key={point.day}>
                    <td className="py-0.5 font-mono text-xs">{point.day}</td>
                    <td className="py-0.5 text-right tabular-nums">{point.downloads.toLocaleString("en")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
