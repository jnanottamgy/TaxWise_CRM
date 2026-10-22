import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { env } from "@/lib/env";
import { log, logUnexpected } from "@/lib/log";
import { stateOptions } from "@/lib/domain/india-validators";
import { AuthCard } from "../_components/auth-card";
import { FormMessage } from "../_components/form-bits";
import { FIRM_DEFAULTS, type FirmDetails } from "@/lib/auth/firm-defaults";
import { isFirstRun, loadFirmDetailsForSetup } from "@/server/auth";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up TaxWise" };

/**
 * First run (§4.3). Exists only while the `profiles` table is empty, checked on every request;
 * after the first Partner is created it is a 404 forever. There is no public sign-up.
 */
export default async function SetupPage() {
  await connection(); // never prerendered: the check must run per request

  let firstRun: boolean;
  try {
    firstRun = await isFirstRun();
  } catch (err) {
    const ref = logUnexpected(err, { source: "page:/setup" });
    return (
      <AuthCard title="Set up TaxWise">
        <div className="flex flex-col gap-4">
          <FormMessage
            notice={{
              message: `We couldn't check the database, so set-up can't start. Make sure the database migrations have been applied, then reload this page. If it keeps happening, quote Ref ${ref}.`,
              ref,
            }}
          />
          <a href="/setup" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Reload
          </a>
        </div>
      </AuthCard>
    );
  }
  if (!firstRun) notFound();

  let firm: FirmDetails;
  try {
    firm = await loadFirmDetailsForSetup();
  } catch (err) {
    log("warn", "firm_settings read failed on /setup; using the defaults", { source: "page:/setup", err });
    firm = { ...FIRM_DEFAULTS };
  }

  return (
    <AuthCard
      size="lg"
      title="Set up TaxWise"
      description="Create the first Partner's login and confirm the firm's details. This page disappears once you're done."
    >
      <SetupForm
        firm={firm}
        lockedEmail={env.firstPartnerEmail()?.trim().toLowerCase() || null}
        states={stateOptions().map(({ code, name }) => ({ code, name }))}
      />
    </AuthCard>
  );
}
