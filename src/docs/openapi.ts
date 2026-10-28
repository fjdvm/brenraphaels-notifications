import { z } from 'zod';
import type { ZodType } from 'zod';
import { routes, type RouteSpec } from './contract';

type Json = Record<string, unknown>;

const jsonSchema = (schema: ZodType, io: 'input' | 'output'): Json => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    reused: 'inline',
    unrepresentable: 'any',
    // A Date travels as an ISO string.
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'date') {
        jsonSchema.type = 'string';
        jsonSchema.format = 'date-time';
      }
    },
  }) as Json;
  return rest;
};

const errorDescriptions: Record<number, string> = {
  400: 'Malformed JSON or a field that fails validation.',
  401: 'Missing or wrong bearer token.',
  404: 'Not found.',
  426: 'Not a WebSocket upgrade request.',
  500: 'Unexpected failure.',
};

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const pathParams = (path: string) =>
  [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);

function operation(name: string, spec: RouteSpec): Json {
  const query = spec.query
    ? (jsonSchema(spec.query, 'input') as {
        properties?: Record<string, Json>;
        required?: string[];
      })
    : undefined;
  // A GET reads its inputs from the query string; a POST may also take them
  // in the body, where the body schema already describes them.
  const parameters: Json[] = [
    ...pathParams(spec.path).map((param) => ({
      name: param,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...Object.entries(query?.properties ?? {}).map(([param, schema]) => ({
      name: param,
      in: 'query',
      required: query?.required?.includes(param) ?? false,
      schema,
    })),
  ];
  if (spec.headers) {
    const headers = jsonSchema(spec.headers, 'input') as {
      properties?: Record<string, Json>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(headers.properties ?? {})) {
      parameters.push({
        name,
        in: 'header',
        required: headers.required?.includes(name) ?? false,
        schema,
      });
    }
  }
  const responses: Record<string, Json> = {
    [spec.success.status]: {
      description: spec.success.description,
      ...(spec.success.schema
        ? {
            content: {
              'application/json': {
                schema: jsonSchema(spec.success.schema, 'output'),
              },
            },
          }
        : {}),
    },
  };
  const errors =
    spec.auth === 'open'
      ? spec.errors
      : [...new Set([...spec.errors, 400, 401, 500])];
  for (const status of errors.sort((a, b) => a - b)) {
    responses[status] = {
      description: errorDescriptions[status] ?? 'Error.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      },
    };
  }
  return {
    operationId: name,
    summary: spec.summary,
    ...(spec.auth === 'open' ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(spec.body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: jsonSchema(spec.body, 'input') },
            },
          },
        }
      : {}),
    responses,
  };
}

// Generated from the route list and the schemas the routes validate with.
export function buildOpenApiDocument(): Json {
  const paths: Record<string, Json> = {};
  for (const [name, spec] of Object.entries(routes) as [string, RouteSpec][]) {
    (paths[toOpenApiPath(spec.path)] ??= {})[spec.method] = operation(
      name,
      spec,
    );
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Notifications',
      version: '1.0.0',
      description:
        'Real-time in-app Notifications, Emails and Ticket Conversation relay for the company Apps.',
    },
    security: [{ BearerToken: [] }],
    paths,
    components: {
      securitySchemes: {
        BearerToken: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            errors: {
              type: 'object',
              description: 'Validation problems by field.',
              additionalProperties: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
