import { GaugeIcon } from "@phosphor-icons/react/ssr"

/**
 * The form half of the sign-in and register pages: a heading, a sentence, the form,
 * and the switch to the other page, centred in the column.
 *
 * Below `lg`, where the navy panel is hidden, a small wordmark sits above the form so
 * the page still says whose it is.
 */
export function AuthFormColumn({
  title,
  description,
  footer,
  children,
}: Readonly<{
  title: string
  description: string
  footer: React.ReactNode
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-svh flex-col px-4 py-10 sm:px-10 lg:px-16">
      <div className="flex items-center gap-2 text-[15px] font-semibold lg:hidden">
        <GaugeIcon aria-hidden="true" weight="duotone" className="size-6 text-primary" />
        Utilize Space
      </div>

      <div className="flex flex-1 items-center justify-center py-10">
        <div className="flex w-full max-w-[23.75rem] flex-col gap-7">
          <div className="flex flex-col gap-2">
            <h1 className="text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.025em]">
              {title}
            </h1>
            <p className="text-[15px] leading-normal text-muted-foreground">{description}</p>
          </div>

          {children}

          <p className="text-center text-sm text-muted-foreground">{footer}</p>
        </div>
      </div>
    </div>
  )
}
