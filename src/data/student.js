export const student = {
  studentId: '20241234',
  name: 'Nguyen Minh Anh',
  nationality: 'Vietnam',
  department: 'Computer Science',
  grade: 2,
  gpa: '3.72 / 4.50',
  preferredLanguage: 'English',
  age: 23,
  residence: 'Jeollanam-do',
  enrollmentStatus: 'ENROLLED',
  employmentStatus: 'UNEMPLOYED',
  interests: ['CAREER', 'EDUCATION', 'FINANCIAL_SUPPORT'],
  courses: ['Data Structures', 'Web Programming', 'Academic Korean'],
  majorKeywords: ['Algorithm', 'Database', 'JavaScript', 'Network']
};

export const dashboardData = {
  recentLectures: [
    { title: 'Data Structures · Linked Lists', time: 'Today, 10:00', status: 'Ready' },
    { title: 'Web Programming · CSS Layout', time: 'Yesterday, 14:00', status: 'Saved' }
  ],
  recentNotes: [
    { title: 'Stack & Queue — review notes', course: 'Data Structures', date: 'Sep 16' },
    { title: 'Responsive design checklist', course: 'Web Programming', date: 'Sep 15' }
  ],
  events: [
    { title: 'Web programming assignment', date: 'Sep 22', color: 'coral' },
    { title: 'Korean study group', date: 'Sep 24', color: 'blue' }
  ]
};

export const boardPosts = [
  { title: 'Could someone explain linked-list deletion?', category: 'Course question', author: 'Yuki', replies: 4, status: 'Answered' },
  { title: 'Tips for the midterm presentation?', category: 'Study tip', author: 'Minh', replies: 0, status: 'Waiting' },
  { title: 'Looking for a database project partner', category: 'Major', author: 'Sara', replies: 2, status: 'Answered' }
];
