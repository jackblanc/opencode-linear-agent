import { z } from "zod";

export const configFileSchema = z.object({
  webhookServerPublicHostname: z.string().min(1),
  webhookServerPort: z.coerce.number().default(3210),
  opencodeServerUrl: z.string().min(1).default("http://localhost:4096"),

  linearClientId: z.string().min(1),
  linearClientSecret: z.string().min(1),
  linearWebhookSecret: z.string().min(1),
  linearWebhookIps: z
    .array(z.string())
    .min(1)
    .default(["35.231.147.226", "35.243.134.228", "34.145.29.68"]),
  linearOrganizationId: z.string().optional(),

  projectsPath: z.string().min(1),
});

export type ApplicationConfig = z.infer<typeof configFileSchema>;
