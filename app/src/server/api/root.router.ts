import { promptVariantsRouter } from "~/server/api/routers/promptVariants.router";
import { createTRPCRouter } from "~/server/api/trpc";
import { experimentsRouter } from "./routers/experiments.router";
import { scenariosRouter } from "./routers/scenarios.router";
import { scenarioVariantCellsRouter } from "./routers/scenarioVariantCells.router";
import { scenarioVarsRouter } from "./routers/scenarioVariables.router";
import { evaluationsRouter } from "./routers/evaluations.router";
import { worldChampsRouter } from "./routers/worldChamps.router";
import { projectsRouter } from "./routers/projects.router";
import { dashboardRouter } from "./routers/dashboard.router";
import { loggedCallsRouter } from "./routers/loggedCalls.router";
import { datasetsRouter } from "./routers/datasets.router";
import { datasetEntriesRouter } from "./routers/datasetEntries.router";
import { pruningRulesRouter } from "./routers/pruningRules.router";
import { fineTunesRouter } from "./routers/fineTunes.router";
import { usersRouter } from "./routers/users.router";
import { adminJobsRouter } from "./routers/adminJobs.router";
import { adminUsersRouter } from "./routers/adminUsers.router";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  promptVariants: promptVariantsRouter,
  experiments: experimentsRouter,
  scenarios: scenariosRouter,
  scenarioVariantCells: scenarioVariantCellsRouter,
  scenarioVars: scenarioVarsRouter,
  evaluations: evaluationsRouter,
  worldChamps: worldChampsRouter,
  projects: projectsRouter,
  dashboard: dashboardRouter,
  loggedCalls: loggedCallsRouter,
  datasets: datasetsRouter,
  datasetEntries: datasetEntriesRouter,
  pruningRules: pruningRulesRouter,
  fineTunes: fineTunesRouter,
  users: usersRouter,
  adminJobs: adminJobsRouter,
  adminUsers: adminUsersRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
