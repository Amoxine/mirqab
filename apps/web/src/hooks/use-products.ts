import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export interface ProductApiSummary {
  id: string;
  name: string;
  slug: string;
}

/** `GET|POST|PATCH /products*` (U10) — a bundle of APIs a developer browses; grants nothing on its
 * own (see the backend's doc comment — access still comes from a key's own access rights). */
export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  apis: ProductApiSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductFormPayload {
  name: string;
  slug: string;
  description?: string;
  /** Replaces the whole membership; omitted on PATCH leaves it unchanged. */
  apiIds?: string[];
}

function invalidateProducts(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.products.all });
}

export function useProducts() {
  return useQuery({
    queryKey: queryKeys.products.all,
    queryFn: () => api.get<Product[]>('/products').then((res) => res.data),
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProductFormPayload) => api.post<Product>('/products', data).then((res) => res.data),
    onSuccess: () => invalidateProducts(qc),
  });
}

export function useUpdateProduct(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ProductFormPayload>) =>
      api.patch<Product>(`/products/${id}`, data).then((res) => res.data),
    onSuccess: () => invalidateProducts(qc),
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ message: string }>(`/products/${id}`).then((res) => res.data),
    onSuccess: () => invalidateProducts(qc),
  });
}
