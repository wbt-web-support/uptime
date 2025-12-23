"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { Globe, Link as LinkIcon, Tag, ListFilter, Plus, X } from "lucide-react";
import LoadingSpinner from "./LoadingSpinner";

interface DomainFormProps {
  onSuccess?: () => void;
  onSave?: () => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function DomainForm({ onSuccess, onSave, isOpen: externalIsOpen, onOpenChange }: DomainFormProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);

  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const setIsOpen = (open: boolean) => {
    if (onOpenChange) onOpenChange(open);
    setInternalIsOpen(open);
  };

  const [formData, setFormData] = useState({
    domain_name: "",
    display_name: "",
    uptime_url: "",
    category: "Live Website",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const supabase = createClient();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const addDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    // Input validation
    if (!formData.domain_name || !formData.uptime_url) {
      setError("Domain name and uptime URL are required");
      return;
    }

    try {
      setLoading(true);

      // Check for duplicates
      const { data: existingDomains, error: checkError } = await supabase
        .from("domains")
        .select("id")
        .eq("uptime_url", formData.uptime_url);

      if (checkError) throw checkError;

      if (existingDomains && existingDomains.length > 0) {
        setError("Domain with this URL already exists");
        setLoading(false);
        return;
      }

      const { data, error } = await supabase.from("domains").insert([
        {
          domain_name: formData.domain_name,
          display_name: formData.display_name || null,
          uptime_url: formData.uptime_url,
          category: formData.category,
        },
      ]).select();

      if (error) throw error;

      // Check the domain's uptime immediately after adding
      if (data && data.length > 0) {
        try {
          // Use the check uptime API
          const response = await fetch('/api/check/uptime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              domainId: data[0].id,
              url: data[0].uptime_url
            })
          });

          // The notification will be triggered by the API if the site is down
          console.log('Initial uptime check performed for new domain');
        } catch (checkError) {
          console.error('Failed to perform initial uptime check:', checkError);
        }
      }

      setSuccess("Domain added successfully!");
      setFormData({
        domain_name: "",
        display_name: "",
        uptime_url: "",
        category: "Live Website",
      });

      // Call callbacks
      if (onSuccess) onSuccess();
      if (onSave) onSave();
      setIsOpen(false); // Close after successful addition
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) {
    return (
      <></>
    );
  }

  return (
    <div id="add-domain-form" className="card mb-8 animate-in slide-in-from-top-4 duration-300">
      <div className="card-header flex flex-row justify-between items-center bg-muted/30">
        <div>
          <h2 className="card-title text-xl font-bold">Add New Domain</h2>
          <p className="card-description">Add a new domain to monitor its uptime, SSL certificate, and expiry date</p>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors"
          title="Close form"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      <div className="p-6">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
            {success}
          </div>
        )}

        <form id="domain-form" onSubmit={addDomain} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <label htmlFor="domain_name" className="block text-sm font-medium text-foreground mb-1.5">
                Domain Name*
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                </div>
                <input
                  type="text"
                  id="domain_name"
                  name="domain_name"
                  value={formData.domain_name}
                  onChange={handleInputChange}
                  placeholder="example.com"
                  className="w-full pl-10 py-2.5 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="display_name" className="block text-sm font-medium text-foreground mb-1.5">
                Display Name (Optional)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                </div>
                <input
                  type="text"
                  id="display_name"
                  name="display_name"
                  value={formData.display_name}
                  onChange={handleInputChange}
                  placeholder="My Website"
                  className="w-full pl-10 py-2.5 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                />
              </div>
            </div>

            <div>
              <label htmlFor="uptime_url" className="block text-sm font-medium text-foreground mb-1.5">
                URL to Check*
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <LinkIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <input
                  type="url"
                  id="uptime_url"
                  name="uptime_url"
                  value={formData.uptime_url}
                  onChange={handleInputChange}
                  placeholder="https://example.com"
                  className="w-full pl-10 py-2.5 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="category" className="block text-sm font-medium text-foreground mb-1.5">
                Category
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <ListFilter className="h-4 w-4 text-muted-foreground" />
                </div>
                <select
                  id="category"
                  name="category"
                  value={formData.category}
                  onChange={handleSelectChange}
                  className="w-full pl-10 py-2.5 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background appearance-none"
                >
                  <option value="Live Website">Live Website</option>
                  <option value="Live Website Temporary Suspended">Live Website Temporary Suspended</option>
                  <option value="Migration Done">Migration Done</option>
                  <option value="Migration Pending">Migration Pending</option>
                  <option value="sub Domain">sub Domain</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={loading}
              className="btn-brand px-8 py-2.5 flex items-center gap-2 text-base font-semibold shadow-md hover:shadow-lg transition-all"
            >
              {loading ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Processing...</span>
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5" />
                  <span>Add Domain</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}