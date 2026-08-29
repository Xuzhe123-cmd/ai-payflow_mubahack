"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { SupplierRegistry } from "@/components/suppliers/SupplierRegistry";

export default function SuppliersPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Suppliers"
        subtitle="The approved registry the treasury pays from. Approval and wallet are re-checked on chain at execution, so this list is authorization, not a directory."
      />
      <SupplierRegistry />
    </PageContainer>
  );
}
