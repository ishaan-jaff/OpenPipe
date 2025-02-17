import { type Prisma } from "@prisma/client";
import { type JsonValue } from "type-fest";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "~/server/db";
import { hashRequest } from "~/server/utils/hashObject";
import { default as openaAIModelProvider } from "~/modelProviders/openai-ChatCompletion";
import { default as fineTunedModelProvider } from "~/modelProviders/fine-tuned";
import {
  type ChatCompletion,
  type CompletionCreateParams,
} from "openai/resources/chat/completions";
import { createOpenApiRouter, openApiProtectedProc } from "./openApiTrpc";
import { TRPCError } from "@trpc/server";
import { getCompletion } from "~/modelProviders/fine-tuned/getCompletion";

const reqValidator = z.object({
  model: z.string(),
  messages: z.array(z.any()),
});

const respValidator = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(
    z.object({
      finish_reason: z.string(),
    }),
  ),
});

export const v1ApiRouter = createOpenApiRouter({
  checkCache: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/check-cache",
        description: "Check if a prompt is cached",
        protect: true,
      },
    })
    .input(
      z.object({
        requestedAt: z.number().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        tags: z
          .record(z.string())
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          )
          .default({}),
      }),
    )
    .output(
      z.object({
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const reqPayload = await reqValidator.spa(input.reqPayload);
      const cacheKey = hashRequest(ctx.key.projectId, reqPayload as JsonValue);

      const existingResponse = await prisma.loggedCallModelResponse.findFirst({
        where: { cacheKey },
        include: { originalLoggedCall: true },
        orderBy: { requestedAt: "desc" },
      });

      if (!existingResponse) return { respPayload: null };

      const newCall = await prisma.loggedCall.create({
        data: {
          projectId: ctx.key.projectId,
          requestedAt: new Date(input.requestedAt),
          cacheHit: true,
          modelResponseId: existingResponse.id,
        },
      });

      await createTags(newCall.projectId, newCall.id, input.tags);
      return {
        respPayload: existingResponse.respPayload,
      };
    }),

  createChatCompletion: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/chat/completions",
        description: "Create completion for a prompt",
        protect: true,
      },
    })
    .input(
      z.object({
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
      }),
    )
    .output(z.unknown().describe("JSON-encoded response payload"))
    .mutation(async ({ input, ctx }) => {
      const { key } = ctx;
      const reqPayload = await reqValidator.spa(input.reqPayload);

      if (!reqPayload.success) {
        throw new TRPCError({
          message: "The request payload must contain a valid model and messages",
          code: "BAD_REQUEST",
        });
      }

      const modelSlug = reqPayload.data.model.replace("openpipe:", "");
      const fineTune = await prisma.fineTune.findUnique({
        where: { slug: modelSlug },
        include: {
          dataset: {
            select: {
              pruningRules: {
                select: {
                  textToMatch: true,
                },
              },
            },
          },
        },
      });
      if (!fineTune) {
        throw new TRPCError({ message: "The model does not exist", code: "NOT_FOUND" });
      }
      if (fineTune.projectId !== key.projectId) {
        throw new TRPCError({
          message: "The model does not belong to this project",
          code: "FORBIDDEN",
        });
      }
      if (!fineTune.inferenceUrl) {
        throw new TRPCError({
          message: "The model is not set up for inference",
          code: "BAD_REQUEST",
        });
      }

      let completion: ChatCompletion;
      try {
        completion = await getCompletion(
          reqPayload.data,
          fineTune.inferenceUrl,
          fineTune.dataset.pruningRules.map((rule) => rule.textToMatch),
        );
      } catch (error: unknown) {
        throw new TRPCError({
          message: `Failed to get completion: ${(error as Error).message}`,
          code: "BAD_REQUEST",
        });
      }

      return completion;
    }),

  report: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/report",
        description: "Report an API call",
        protect: true,
      },
    })
    .input(
      z.object({
        requestedAt: z.number().describe("Unix timestamp in milliseconds"),
        receivedAt: z.number().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
        statusCode: z.number().optional().describe("HTTP status code of response"),
        errorMessage: z.string().optional().describe("User-friendly error message"),
        tags: z
          .record(z.string())
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          )
          .default({}),
      }),
    )
    .output(z.object({ status: z.union([z.literal("ok"), z.literal("error")]) }))
    .mutation(async ({ input, ctx }) => {
      const reqPayload = await reqValidator.spa(input.reqPayload);
      const respPayload = await respValidator.spa(input.respPayload);

      const requestHash = hashRequest(ctx.key.projectId, reqPayload as JsonValue);

      const newLoggedCallId = uuidv4();
      const newModelResponseId = uuidv4();

      let usage;
      let model;
      if (reqPayload.success) {
        model = reqPayload.data.model;
        if (model.startsWith("openpipe:")) {
          const fineTune = await prisma.fineTune.findUnique({
            where: { slug: model.replace("openpipe:", "") },
            select: { baseModel: true },
          });
          usage = fineTunedModelProvider.getUsage(
            input.reqPayload as CompletionCreateParams,
            respPayload.success ? (input.respPayload as ChatCompletion) : undefined,
            { baseModel: fineTune?.baseModel },
          );
        } else {
          usage = openaAIModelProvider.getUsage(
            input.reqPayload as CompletionCreateParams,
            respPayload.success ? (input.respPayload as ChatCompletion) : undefined,
          );
        }
      }

      await prisma.$transaction([
        prisma.loggedCall.create({
          data: {
            id: newLoggedCallId,
            projectId: ctx.key.projectId,
            requestedAt: new Date(input.requestedAt),
            cacheHit: false,
            model,
          },
        }),
        prisma.loggedCallModelResponse.create({
          data: {
            id: newModelResponseId,
            originalLoggedCallId: newLoggedCallId,
            requestedAt: new Date(input.requestedAt),
            receivedAt: new Date(input.receivedAt),
            reqPayload: input.reqPayload as Prisma.InputJsonValue,
            respPayload: input.respPayload as Prisma.InputJsonValue,
            statusCode: input.statusCode,
            errorMessage: input.errorMessage,
            durationMs: input.receivedAt - input.requestedAt,
            cacheKey: respPayload.success ? requestHash : null,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            cost: usage?.cost,
          },
        }),
        // Avoid foreign key constraint error by updating the logged call after the model response is created
        prisma.loggedCall.update({
          where: {
            id: newLoggedCallId,
          },
          data: {
            modelResponseId: newModelResponseId,
          },
        }),
      ]);

      await createTags(ctx.key.projectId, newLoggedCallId, input.tags);
      return { status: "ok" };
    }),
  localTestingOnlyGetLatestLoggedCall: openApiProtectedProc
    .meta({
      openapi: {
        method: "GET",
        path: "/local-testing-only-get-latest-logged-call",
        description: "Get the latest logged call (only for local testing)",
        protect: true, // Make sure to protect this endpoint
      },
    })
    .input(z.void())
    .output(
      z
        .object({
          createdAt: z.date(),
          cacheHit: z.boolean(),
          tags: z.record(z.string().nullable()),
          modelResponse: z
            .object({
              id: z.string(),
              statusCode: z.number().nullable(),
              errorMessage: z.string().nullable(),
              reqPayload: z.unknown(),
              respPayload: z.unknown(),
            })
            .nullable(),
        })
        .nullable(),
    )
    .mutation(async ({ ctx }) => {
      if (process.env.NODE_ENV === "production") {
        throw new Error("This operation is not allowed in production environment");
      }

      const latestLoggedCall = await prisma.loggedCall.findFirst({
        where: { projectId: ctx.key.projectId },
        orderBy: { requestedAt: "desc" },
        select: {
          createdAt: true,
          cacheHit: true,
          tags: true,
          id: true,
          modelResponse: {
            select: {
              id: true,
              statusCode: true,
              errorMessage: true,
              reqPayload: true,
              respPayload: true,
            },
          },
        },
      });

      return (
        latestLoggedCall && {
          ...latestLoggedCall,
          tags: Object.fromEntries(latestLoggedCall.tags.map((tag) => [tag.name, tag.value])),
        }
      );
    }),
});

async function createTags(projectId: string, loggedCallId: string, tags: Record<string, string>) {
  const tagsToCreate = Object.entries(tags).map(([name, value]) => ({
    projectId,
    loggedCallId,
    name: name.replaceAll(/[^a-zA-Z0-9_$.]/g, "_"),
    value,
  }));
  await prisma.loggedCallTag.createMany({
    data: tagsToCreate,
  });
}
