import { Search, Filter, Tag, ChevronDown, ArrowUpDown, LayoutGrid, List } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { ReactNode } from 'react';

interface DashboardHeaderProps {
  title: string;
  description?: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  statusFilter: string;
  setStatusFilter: (filter: string) => void;
  categoryFilter?: string;
  setCategoryFilter?: (filter: string) => void;
  categories?: string[];
  totalCount: number;
  filteredCount: number;
  isAdmin?: boolean;
  onAddClick?: () => void;
  rightContent?: ReactNode;
  stats?: {
    total: number;
    up: number;
    down: number;
    sslExpiring: number;
    domainExpiring: number;
  };
  categoryStats?: Record<string, number>;
  sortBy?: string;
  setSortBy?: (value: string) => void;
  viewMode?: 'grid' | 'list';
  setViewMode?: (mode: 'grid' | 'list') => void;
}

export default function DashboardHeader({
  title,
  description,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  categoryFilter = 'all',
  setCategoryFilter = () => { },
  categories = ['all'],
  totalCount,
  filteredCount,
  isAdmin = false,
  onAddClick,
  rightContent,
  stats,
  categoryStats,
  sortBy,
  setSortBy,
  viewMode,
  setViewMode
}: DashboardHeaderProps) {
  const filters = [
    { id: 'all', name: 'All', color: 'bg-brand', count: stats?.total },
    { id: 'up', name: 'Operational', color: 'bg-green-500', count: stats?.up },
    { id: 'down', name: 'Down', color: 'bg-red-500', count: stats?.down },
    { id: 'ssl-expiring', name: 'SSL Expiring', color: 'bg-amber-500', count: stats?.sslExpiring },
    { id: 'domain-expiring', name: 'Domain Expiring', color: 'bg-orange-500', count: stats?.domainExpiring }
  ];

  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6 mb-4">
        {/* Left side: Title and Stats */}
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold text-foreground">{title}</h1>
          {description && <p className="text-muted-foreground mt-1">{description}</p>}
          {/* <div className="text-sm text-muted-foreground">
            Showing {filteredCount} of {totalCount} domains
          </div> */}
        </div>

        {/* Right side: Search, Filters, and Actions */}
        <div className="flex flex-col sm:flex-row flex-wrap lg:justify-end items-center gap-3 w-full lg:w-auto">
          {/* Search Bar */}
          <div className="relative w-full sm:w-64">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-muted-foreground" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search domains..."
              className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background text-sm h-9"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* Sort Dropdown */}
            {setSortBy && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2 flex-grow sm:flex-grow-0">
                    <ArrowUpDown className="h-4 w-4" />
                    <span>Sort: {sortBy === 'domain' ? 'Domain' : sortBy === 'newest' ? 'Newest' : sortBy === 'oldest' ? 'Oldest' : sortBy === 'status' ? 'Status' : 'Name'}</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Sort Options</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setSortBy('domain')} className="cursor-pointer">
                    Sort by Domain
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortBy('status')} className="cursor-pointer">
                    Sort by Status
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortBy('newest')} className="cursor-pointer">
                    Newest First
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortBy('oldest')} className="cursor-pointer">
                    Oldest First
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Status Filter Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2 flex-grow sm:flex-grow-0">
                  <Filter className="h-4 w-4" />
                  <span>Status: {filters.find(f => f.id === statusFilter)?.name || 'All'}</span>
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {filters.map((filter) => (
                  <DropdownMenuItem
                    key={filter.id}
                    onClick={() => setStatusFilter(filter.id)}
                    className="flex items-center justify-between cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${filter.color}`} />
                      <span>{filter.name}</span>
                    </div>
                    {filter.count !== undefined && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {filter.count}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Category Filter Dropdown */}
            {categories.filter(c => c !== 'all').length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2 flex-grow sm:flex-grow-0">
                    <Tag className="h-4 w-4" />
                    <span>Category: {categoryFilter === 'all' ? 'Select...' : categoryFilter}</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Filter by Category</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {categories
                    .filter(category => category !== 'all')
                    .map((category) => (
                      <DropdownMenuItem
                        key={category}
                        onClick={() => setCategoryFilter(category)}
                        className="flex items-center justify-between cursor-pointer"
                      >
                        <span>{category}</span>
                        {categoryStats && categoryStats[category] !== undefined && (
                          <span className="text-xs text-muted-foreground font-mono">
                            {categoryStats[category]}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* View Mode Toggle */}
            {setViewMode && (
              <div className="flex items-center bg-muted rounded-md p-0.5 h-9 border border-input">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1 rounded ${viewMode === 'grid' ? 'bg-background shadow-sm text-brand' : 'text-muted-foreground hover:text-foreground'}`}
                  title="Grid View"
                >
                  <LayoutGrid size={18} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-1 rounded ${viewMode === 'list' ? 'bg-background shadow-sm text-brand' : 'text-muted-foreground hover:text-foreground'}`}
                  title="List View"
                >
                  <List size={18} />
                </button>
              </div>
            )}

            {isAdmin && (
              <button
                className="btn-brand h-9 px-4 py-2 text-sm flex-grow sm:flex-grow-0"
                style={{ textWrap: 'nowrap' }}
                onClick={() => {
                  if (onAddClick) {
                    onAddClick();
                  } else {
                    document.getElementById('add-domain-form')?.scrollIntoView({ behavior: 'smooth' });
                  }
                }}
              >
                Add New Domain
              </button>
            )}

            {rightContent && (
              <div className="flex-grow sm:flex-grow-0">
                {rightContent}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}